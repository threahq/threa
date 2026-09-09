import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Pool } from "pg"
import { Visibilities } from "@threahq/types"
import { setupTestDatabase, withTransaction, addTestMember } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { FeatureFlagOverrideRepository, FeatureFlagService } from "../../src/features/feature-flags"
import { StreamService } from "../../src/features/streams"
import { CallService, CallRepository, CallEndpointRepository } from "../../src/features/calls"
import { workspaceId as newWorkspaceId } from "../../src/lib/id"
import { CallTransportSessionRepository } from "../../src/features/calls/transfer-repository"

let pool: Pool
let streams: StreamService
let featureFlags: FeatureFlagService
let calls: CallService

beforeAll(async () => {
  pool = await setupTestDatabase()
  streams = new StreamService(pool)
  featureFlags = new FeatureFlagService(pool)
  calls = new CallService({
    pool,
    featureFlagService: featureFlags,
    turnIssuer: { issue: async () => ({ iceServers: [], expiresAt: new Date(Date.now() + 60_000).toISOString() }) },
  })
})

afterAll(async () => {
  await pool.end()
})

async function seedScenario(p2pEnabled = true) {
  const workspaceId = newWorkspaceId()
  let aUserId = ""
  let bUserId = ""
  await withTransaction(pool, async (client) => {
    await WorkspaceRepository.insert(client, {
      id: workspaceId,
      name: "P2P integration",
      slug: `p2p-${workspaceId}`,
      createdBy: workspaceId,
    })
    aUserId = (await addTestMember(client, workspaceId, "p2p-a")).id
    bUserId = (await addTestMember(client, workspaceId, "p2p-b")).id
    if (p2pEnabled) {
      await FeatureFlagOverrideRepository.replaceForSubject(client, workspaceId, "workspace", workspaceId, {
        callsP2p: "on",
      })
    }
  })
  const stream = await streams.createChannel({
    workspaceId,
    slug: `p2p-${workspaceId}`,
    displayName: "P2P integration",
    createdBy: aUserId,
    visibility: Visibilities.PRIVATE,
    memberIds: [bUserId],
  })
  return { workspaceId, streamId: stream.id, aUserId, bUserId }
}

describe("calls P2P schema and negotiation state", () => {
  test("should issue TURN credentials only to a capable P2P endpoint with a current lease", async () => {
    const scenario = await seedScenario()
    let issued = 0
    const credentials = {
      iceServers: [{ urls: "turn:example.test:3478", username: "test-user", credential: "test-credential" }],
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    }
    const service = new CallService({
      pool,
      featureFlagService: featureFlags,
      turnIssuer: {
        issue: async () => {
          issued++
          return credentials
        },
      },
    })
    const params = {
      workspaceId: scenario.workspaceId,
      streamId: scenario.streamId,
      userId: scenario.aUserId,
      mode: "video" as const,
      mediaIncarnation: "inc_turn",
      transportCapability: "p2p-v1",
      transferCapability: "transport-transfer-v1" as const,
    }
    const sfu = await service.startCall(params)
    await expect(
      service.issueTurnCredentials({ ...params, callId: sfu.call.id, endpointId: sfu.endpoint.id })
    ).rejects.toMatchObject({ code: "CALL_P2P_UNAVAILABLE" })
    await service.leaveCallAsUser({ workspaceId: scenario.workspaceId, callId: sfu.call.id, userId: scenario.aUserId })
    const p2p = await service.startCall({ ...params, callsP2pEnabled: true, turnConfigured: true })
    const endpointParams = { ...params, callId: p2p.call.id, endpointId: p2p.endpoint.id }
    expect(await service.issueTurnCredentials(endpointParams)).toEqual(credentials)
    await CallEndpointRepository.rebind(pool, {
      workspaceId: scenario.workspaceId,
      id: p2p.endpoint.id,
      mediaIncarnation: params.mediaIncarnation,
      transportCapability: "p2p-v1",
      leaseExpiresAt: new Date(Date.now() - 1_000),
    })
    await expect(service.issueTurnCredentials(endpointParams)).rejects.toMatchObject({ code: "CALL_P2P_UNAVAILABLE" })
    expect(issued).toBe(1)
  })

  test("should reject a new P2P target when workspace enrollment is off without writing transfer state", async () => {
    const scenario = await seedScenario(false)
    const started = await calls.startCall({
      ...scenario,
      userId: scenario.aUserId,
      mode: "video",
      mediaIncarnation: "inc_a",
      transportCapability: "p2p-v1",
      transferCapability: "transport-transfer-v1",
    })

    await expect(
      calls.requestTransportTransfer({
        workspaceId: scenario.workspaceId,
        callId: started.call.id,
        userId: scenario.aUserId,
        endpointId: started.endpoint.id,
        target: "p2p",
        idempotencyKey: "disabled-workspace",
      })
    ).rejects.toMatchObject({ status: 404, code: "CALL_P2P_UNAVAILABLE" })

    const [transfers, transferEvents] = await Promise.all([
      pool.query(`SELECT id FROM call_transport_transfers WHERE workspace_id = $1 AND call_id = $2`, [
        scenario.workspaceId,
        started.call.id,
      ]),
      pool.query(
        `SELECT id FROM outbox WHERE event_type = 'call:transport_transfer_changed' AND payload->>'workspaceId' = $1`,
        [scenario.workspaceId]
      ),
    ])
    expect({ transfers: transfers.rows, transferEvents: transferEvents.rows }).toEqual({
      transfers: [],
      transferEvents: [],
    })
  })

  test("should persist transport capability and generation-qualified publications in the real schema", async () => {
    const scenario = await seedScenario()
    const started = await calls.startCall({
      ...scenario,
      userId: scenario.aUserId,
      mode: "video",
      mediaIncarnation: "inc_a",
      transportCapability: "p2p-v1",
      transferCapability: "transport-transfer-v1",
      callsP2pEnabled: true,
      turnConfigured: true,
    })
    const joined = await calls.joinCall({
      workspaceId: scenario.workspaceId,
      callId: started.call.id,
      userId: scenario.bUserId,
      mediaIncarnation: "inc_b",
      transportCapability: "p2p-v1",
      transferCapability: "transport-transfer-v1",
    })

    const snapshot = await calls.setP2pPublications({
      workspaceId: scenario.workspaceId,
      callId: started.call.id,
      userId: scenario.aUserId,
      endpointId: started.endpoint.id,
      endpointEpoch: started.endpoint.epoch,
      endpointConnectionSeq: started.endpoint.connectionSeq,
      mediaIncarnation: "inc_a",
      generation: 1,
      revision: 1,
      publications: [
        { kind: "mic", publicationId: "pub_mic" },
        { kind: "camera", publicationId: "pub_camera" },
      ],
    })

    const call = await CallRepository.findById(pool, scenario.workspaceId, started.call.id)
    const firstEndpoint = await CallEndpointRepository.findById(pool, scenario.workspaceId, started.endpoint.id)
    const secondEndpoint = await CallEndpointRepository.findById(pool, scenario.workspaceId, joined.endpoint.id)
    expect({
      transport: call && { mediaTransport: call.mediaTransport, transportGeneration: call.transportGeneration },
      firstEndpoint: firstEndpoint && {
        transportCapability: firstEndpoint.transportCapability,
        publishedTracks: firstEndpoint.publishedTracks,
      },
      secondCapability: secondEndpoint?.transportCapability,
      rosterTransport: { mediaTransport: snapshot.mediaTransport, transportGeneration: snapshot.transportGeneration },
    }).toEqual({
      transport: { mediaTransport: "p2p", transportGeneration: 1 },
      firstEndpoint: {
        transportCapability: "p2p-v1",
        publishedTracks: [
          { kind: "mic", trackName: `${started.endpoint.id}:mic`, publicationId: "pub_mic", transportGeneration: 1 },
          {
            kind: "camera",
            trackName: `${started.endpoint.id}:camera`,
            publicationId: "pub_camera",
            transportGeneration: 1,
          },
        ],
      },
      secondCapability: "p2p-v1",
      rosterTransport: { mediaTransport: "p2p", transportGeneration: 1 },
    })
  })

  test("should prepare a generation-qualified P2P target for more than six admitted SFU endpoints", async () => {
    const workspaceId = newWorkspaceId()
    const userIds: string[] = []
    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: workspaceId,
        name: "Transfer integration",
        slug: `transfer-${workspaceId}`,
        createdBy: workspaceId,
      })
      for (let index = 0; index < 7; index++)
        userIds.push((await addTestMember(client, workspaceId, `transfer-${index}`)).id)
      await FeatureFlagOverrideRepository.replaceForSubject(client, workspaceId, "workspace", workspaceId, {
        callsP2p: "on",
      })
    })
    const stream = await streams.createChannel({
      workspaceId,
      slug: `transfer-${workspaceId}`,
      displayName: "Transfer integration",
      createdBy: userIds[0]!,
      visibility: Visibilities.PRIVATE,
      memberIds: userIds.slice(1),
    })
    const started = await calls.startCall({
      workspaceId,
      streamId: stream.id,
      userId: userIds[0]!,
      mode: "video",
      mediaIncarnation: "inc_0",
      transportCapability: "p2p-v1",
      transferCapability: "transport-transfer-v1",
    })
    const endpoints = [started.endpoint]
    for (let index = 1; index < userIds.length; index++) {
      const joined = await calls.joinCall({
        workspaceId,
        callId: started.call.id,
        userId: userIds[index]!,
        mediaIncarnation: `inc_${index}`,
        transportCapability: "p2p-v1",
        transferCapability: "transport-transfer-v1",
      })
      endpoints.push(joined.endpoint)
    }

    const snapshot = await calls.requestTransportTransfer({
      workspaceId,
      callId: started.call.id,
      userId: userIds[0]!,
      endpointId: started.endpoint.id,
      target: "p2p",
      idempotencyKey: "seven-endpoints",
    })
    const sessions = await CallTransportSessionRepository.listByCall(pool, workspaceId, started.call.id)
    expect({
      active: { transport: snapshot.mediaTransport, generation: snapshot.transportGeneration },
      transfer: snapshot.transfer && { phase: snapshot.transfer.phase, target: snapshot.transfer.target },
      sessions: sessions.map(({ endpointId, transportGeneration, mediaTransport, status }) => ({
        endpointId,
        transportGeneration,
        mediaTransport,
        status,
      })),
    }).toEqual({
      active: { transport: "sfu", generation: 1 },
      transfer: { phase: "preparing", target: { generation: 2, transport: "p2p" } },
      sessions: endpoints
        .flatMap(({ id }) => [
          { endpointId: id, transportGeneration: 1, mediaTransport: "sfu", status: "active" },
          { endpointId: id, transportGeneration: 2, mediaTransport: "p2p", status: "preparing" },
        ])
        .sort((a, b) => a.transportGeneration - b.transportGeneration || a.endpointId.localeCompare(b.endpointId)),
    })
  })

  test("should serialize concurrent transfer requests in the real schema", async () => {
    const scenario = await seedScenario()
    const started = await calls.startCall({
      ...scenario,
      userId: scenario.aUserId,
      mode: "video",
      mediaIncarnation: "inc_a",
      transportCapability: "p2p-v1",
      transferCapability: "transport-transfer-v1",
    })
    await calls.joinCall({
      workspaceId: scenario.workspaceId,
      callId: started.call.id,
      userId: scenario.bUserId,
      mediaIncarnation: "inc_b",
      transportCapability: "p2p-v1",
      transferCapability: "transport-transfer-v1",
    })

    const results = await Promise.all([
      calls.requestTransportTransfer({
        workspaceId: scenario.workspaceId,
        callId: started.call.id,
        userId: scenario.aUserId,
        endpointId: started.endpoint.id,
        target: "p2p",
        idempotencyKey: "request-a",
      }),
      calls.requestTransportTransfer({
        workspaceId: scenario.workspaceId,
        callId: started.call.id,
        userId: scenario.aUserId,
        endpointId: started.endpoint.id,
        target: "p2p",
        idempotencyKey: "request-b",
      }),
    ])
    const rows = await pool.query(
      `SELECT id, generation FROM call_transport_transfers WHERE workspace_id = $1 AND call_id = $2`,
      [scenario.workspaceId, started.call.id]
    )

    expect({ transferIds: results.map((result) => result.transfer?.id), rows: rows.rows }).toEqual({
      transferIds: [results[0]!.transfer!.id, results[0]!.transfer!.id],
      rows: [{ id: results[0]!.transfer!.id, generation: 2 }],
    })
  })

  test("should revise only the changed publisher kind without clearing unrelated readiness", async () => {
    const scenario = await seedScenario()
    const started = await calls.startCall({
      ...scenario,
      userId: scenario.aUserId,
      mode: "video",
      mediaIncarnation: "inc_a",
      transportCapability: "p2p-v1",
      transferCapability: "transport-transfer-v1",
    })
    const joined = await calls.joinCall({
      workspaceId: scenario.workspaceId,
      callId: started.call.id,
      userId: scenario.bUserId,
      mediaIncarnation: "inc_b",
      transportCapability: "p2p-v1",
      transferCapability: "transport-transfer-v1",
    })
    await pool.query(
      `UPDATE call_endpoints SET publication_revision = 1, published_tracks = $3::jsonb
      WHERE workspace_id = $1 AND id = $2`,
      [
        scenario.workspaceId,
        started.endpoint.id,
        JSON.stringify([
          { kind: "mic", trackName: `${started.endpoint.id}:mic`, publicationId: "mic_1", transportGeneration: 1 },
          {
            kind: "camera",
            trackName: `${started.endpoint.id}:camera`,
            publicationId: "camera_1",
            transportGeneration: 1,
          },
        ]),
      ]
    )
    const prepared = await calls.requestTransportTransfer({
      workspaceId: scenario.workspaceId,
      callId: started.call.id,
      userId: scenario.aUserId,
      endpointId: started.endpoint.id,
      target: "p2p",
      idempotencyKey: "publication-churn",
    })
    await calls.setP2pPublications({
      workspaceId: scenario.workspaceId,
      callId: started.call.id,
      userId: scenario.aUserId,
      endpointId: started.endpoint.id,
      endpointEpoch: started.endpoint.epoch,
      endpointConnectionSeq: started.endpoint.connectionSeq,
      mediaIncarnation: "inc_a",
      generation: 2,
      revision: 1,
      publications: [
        { kind: "mic", publicationId: "mic_1" },
        { kind: "camera", publicationId: "camera_1" },
      ],
    })
    const registered = await calls.getRosterSnapshot(scenario.workspaceId, started.call.id)
    const bObligation = registered.transfer!.obligations.find((item) => item.endpointId === joined.endpoint.id)!
    await calls.acknowledgeTransferReady({
      workspaceId: scenario.workspaceId,
      callId: started.call.id,
      userId: scenario.bUserId,
      transferId: prepared.transfer!.id,
      generation: 2,
      endpointId: joined.endpoint.id,
      endpointEpoch: joined.endpoint.epoch,
      mediaIncarnation: "inc_b",
      membershipRevision: bObligation.membershipRevision,
      trackRevision: bObligation.trackRevision,
      ownPublicationsReady: true,
      readyPublications: bObligation.expectedPublications,
    })

    await calls.setP2pPublications({
      workspaceId: scenario.workspaceId,
      callId: started.call.id,
      userId: scenario.aUserId,
      endpointId: started.endpoint.id,
      endpointEpoch: started.endpoint.epoch,
      endpointConnectionSeq: started.endpoint.connectionSeq,
      mediaIncarnation: "inc_a",
      generation: 2,
      revision: 2,
      publications: [
        { kind: "mic", publicationId: "mic_1" },
        { kind: "camera", publicationId: "camera_2" },
      ],
    })
    const revised = await calls.getRosterSnapshot(scenario.workspaceId, started.call.id)
    const obligation = revised.transfer!.obligations.find((item) => item.endpointId === joined.endpoint.id)!
    expect({
      expected: obligation.expectedPublications.map((item) => ({ kind: item.kind, publicationId: item.publicationId })),
      ready: obligation.readyPublications.map((item) => ({ kind: item.kind, publicationId: item.publicationId })),
      ownPublicationsReady: obligation.ownPublicationsReady,
    }).toEqual({
      expected: [
        { kind: "mic", publicationId: "mic_1" },
        { kind: "camera", publicationId: "camera_2" },
      ],
      ready: [{ kind: "mic", publicationId: "mic_1" }],
      ownPublicationsReady: true,
    })

    await calls.setEndpointMediaState({
      workspaceId: scenario.workspaceId,
      callId: started.call.id,
      userId: scenario.aUserId,
      endpointId: started.endpoint.id,
      mediaIncarnation: "inc_a",
      mediaState: { muted: true },
    })
    const muted = await calls.getRosterSnapshot(scenario.workspaceId, started.call.id)
    const mutedObligation = muted.transfer!.obligations.find((item) => item.endpointId === joined.endpoint.id)!
    expect({
      mic: mutedObligation.expectedPublications.find((item) => item.kind === "mic"),
      ready: mutedObligation.readyPublications,
    }).toEqual({
      mic: expect.objectContaining({ publicationId: "mic_1", muted: true }),
      ready: [],
    })
  })

  test("should serialize readiness with leave and reject a replaced incarnation's stale acknowledgement", async () => {
    const scenario = await seedScenario()
    const started = await calls.startCall({
      ...scenario,
      userId: scenario.aUserId,
      mode: "video",
      mediaIncarnation: "inc_a",
      transportCapability: "p2p-v1",
      transferCapability: "transport-transfer-v1",
    })
    const joined = await calls.joinCall({
      workspaceId: scenario.workspaceId,
      callId: started.call.id,
      userId: scenario.bUserId,
      mediaIncarnation: "inc_b",
      transportCapability: "p2p-v1",
      transferCapability: "transport-transfer-v1",
    })
    const prepared = await calls.requestTransportTransfer({
      workspaceId: scenario.workspaceId,
      callId: started.call.id,
      userId: scenario.aUserId,
      endpointId: started.endpoint.id,
      target: "p2p",
      idempotencyKey: "churn",
    })
    const aObligation = prepared.transfer!.obligations.find((item) => item.endpointId === started.endpoint.id)!

    await Promise.allSettled([
      calls.acknowledgeTransferReady({
        workspaceId: scenario.workspaceId,
        callId: started.call.id,
        userId: scenario.aUserId,
        transferId: prepared.transfer!.id,
        generation: 2,
        endpointId: started.endpoint.id,
        endpointEpoch: started.endpoint.epoch,
        mediaIncarnation: "inc_a",
        membershipRevision: aObligation.membershipRevision,
        trackRevision: aObligation.trackRevision,
        ownPublicationsReady: true,
        readyPublications: aObligation.expectedPublications,
      }),
      calls.leaveCallAsUser({ workspaceId: scenario.workspaceId, callId: started.call.id, userId: scenario.bUserId }),
    ])
    const afterLeave = await calls.getRosterSnapshot(scenario.workspaceId, started.call.id)
    expect(
      afterLeave.transfer!.obligations.map((item) => ({ endpointId: item.endpointId, switched: item.switched }))
    ).toEqual([{ endpointId: started.endpoint.id, switched: false }])

    await calls.markEndpointReconnecting({
      workspaceId: scenario.workspaceId,
      endpointId: started.endpoint.id,
      epoch: started.endpoint.epoch,
      connectionSeq: started.endpoint.connectionSeq,
    })
    const staleAck = calls.acknowledgeTransferReady({
      workspaceId: scenario.workspaceId,
      callId: started.call.id,
      userId: scenario.aUserId,
      transferId: afterLeave.transfer!.id,
      generation: 2,
      endpointId: started.endpoint.id,
      endpointEpoch: started.endpoint.epoch,
      mediaIncarnation: "inc_a",
      membershipRevision: afterLeave.transfer!.membershipRevision,
      trackRevision: aObligation.trackRevision,
      ownPublicationsReady: true,
      readyPublications: [],
    })
    const takeover = calls.joinCall({
      workspaceId: scenario.workspaceId,
      callId: started.call.id,
      userId: scenario.aUserId,
      mediaIncarnation: "inc_new",
      transportCapability: "p2p-v1",
      transferCapability: "transport-transfer-v1",
    })
    await Promise.allSettled([staleAck, takeover])
    const afterTakeover = await calls.getRosterSnapshot(scenario.workspaceId, started.call.id)
    expect(afterTakeover.transfer!.obligations).toMatchObject([
      { endpointId: started.endpoint.id, mediaIncarnation: "inc_new", ownPublicationsReady: false, switched: false },
    ])
    expect(joined.endpoint.id).not.toBe(started.endpoint.id)
  })

  test("should serialize transport commit with provider session completion", async () => {
    const scenario = await seedScenario()
    let releaseCreate!: () => void
    const createBlocked = new Promise<void>((resolve) => {
      releaseCreate = resolve
    })
    const service = new CallService({
      pool,
      featureFlagService: featureFlags,
      cloudflare: {
        createSession: async () => {
          await createBlocked
          return { sessionId: "cf_committed" }
        },
        closeSession: async () => {},
      } as never,
    })
    const started = await service.startCall({
      ...scenario,
      userId: scenario.aUserId,
      mode: "video",
      mediaIncarnation: "inc_a",
      transportCapability: "p2p-v1",
      transferCapability: "transport-transfer-v1",
      callsP2pEnabled: true,
      turnConfigured: true,
    })
    const prepared = await service.requestTransportTransfer({
      workspaceId: scenario.workspaceId,
      callId: started.call.id,
      userId: scenario.aUserId,
      endpointId: started.endpoint.id,
      target: "sfu",
      idempotencyKey: "commit-provider",
    })
    const obligation = prepared.transfer!.obligations[0]!
    const allocation = service.createEndpointCfSession({
      workspaceId: scenario.workspaceId,
      callId: started.call.id,
      userId: scenario.aUserId,
      endpointId: started.endpoint.id,
      mediaIncarnation: "inc_a",
      generation: 2,
    })
    const ready = {
      workspaceId: scenario.workspaceId,
      callId: started.call.id,
      userId: scenario.aUserId,
      transferId: prepared.transfer!.id,
      generation: 2,
      endpointId: started.endpoint.id,
      endpointEpoch: started.endpoint.epoch,
      mediaIncarnation: "inc_a",
      membershipRevision: obligation.membershipRevision,
      trackRevision: obligation.trackRevision,
      ownPublicationsReady: true as const,
      readyPublications: [],
    }
    await expect(service.acknowledgeTransferReady(ready)).rejects.toMatchObject({ code: "CALL_TARGET_NOT_READY" })
    releaseCreate()
    expect(await allocation).toEqual({ cfSessionId: "cf_committed", idempotent: false })
    await service.acknowledgeTransferReady(ready)
    await service.acknowledgeTransferSwitched({
      workspaceId: scenario.workspaceId,
      callId: started.call.id,
      userId: scenario.aUserId,
      transferId: prepared.transfer!.id,
      generation: 2,
      endpointId: started.endpoint.id,
      endpointEpoch: started.endpoint.epoch,
      mediaIncarnation: "inc_a",
      membershipRevision: obligation.membershipRevision,
      trackRevision: obligation.trackRevision,
    })
    const committed = await CallTransportSessionRepository.find(pool, {
      workspaceId: scenario.workspaceId,
      callId: started.call.id,
      endpointId: started.endpoint.id,
      generation: 2,
    })
    const call = await CallRepository.findById(pool, scenario.workspaceId, started.call.id)
    expect({
      providerSessionId: committed?.providerSessionId,
      generation: call?.transportGeneration,
      transport: call?.mediaTransport,
    }).toEqual({ providerSessionId: "cf_committed", generation: 2, transport: "sfu" })
  })

  test("should close the retired source provider session only after transfer commit", async () => {
    const scenario = await seedScenario()
    const closed: string[] = []
    const service = new CallService({
      pool,
      featureFlagService: featureFlags,
      turnIssuer: { issue: async () => ({ iceServers: [], expiresAt: new Date(Date.now() + 60_000).toISOString() }) },
      cloudflare: {
        closeSession: async (id: string) => {
          closed.push(id)
        },
      } as never,
    })
    const started = await service.startCall({
      ...scenario,
      userId: scenario.aUserId,
      mode: "video",
      mediaIncarnation: "inc_a",
      transportCapability: "p2p-v1",
      transferCapability: "transport-transfer-v1",
    })
    await pool.query(`UPDATE call_endpoints SET cf_session_id = 'cf_source' WHERE workspace_id = $1 AND id = $2`, [
      scenario.workspaceId,
      started.endpoint.id,
    ])
    const prepared = await service.requestTransportTransfer({
      workspaceId: scenario.workspaceId,
      callId: started.call.id,
      userId: scenario.aUserId,
      endpointId: started.endpoint.id,
      target: "p2p",
      idempotencyKey: "source-cleanup",
    })
    const obligation = prepared.transfer!.obligations[0]!
    const identity = {
      workspaceId: scenario.workspaceId,
      callId: started.call.id,
      userId: scenario.aUserId,
      transferId: prepared.transfer!.id,
      generation: 2,
      endpointId: started.endpoint.id,
      endpointEpoch: started.endpoint.epoch,
      mediaIncarnation: "inc_a",
      membershipRevision: obligation.membershipRevision,
      trackRevision: obligation.trackRevision,
    }
    await service.acknowledgeTransferReady({ ...identity, ownPublicationsReady: true, readyPublications: [] })
    expect(closed).toEqual([])
    await service.acknowledgeTransferSwitched(identity)
    expect(closed).toEqual(["cf_source"])
  })

  test("should close both generation session sets and fence an in-flight provider allocation on termination", async () => {
    const scenario = await seedScenario()
    let releaseCreate!: () => void
    const createBlocked = new Promise<void>((resolve) => {
      releaseCreate = resolve
    })
    const closed: string[] = []
    const service = new CallService({
      pool,
      featureFlagService: featureFlags,
      cloudflare: {
        createSession: async () => {
          await createBlocked
          return { sessionId: "cf_inflight" }
        },
        closeSession: async (id: string) => {
          closed.push(id)
        },
      } as never,
    })
    const started = await service.startCall({
      ...scenario,
      userId: scenario.aUserId,
      mode: "video",
      mediaIncarnation: "inc_a",
      transportCapability: "p2p-v1",
      transferCapability: "transport-transfer-v1",
      callsP2pEnabled: true,
      turnConfigured: true,
    })
    const joined = await service.joinCall({
      workspaceId: scenario.workspaceId,
      callId: started.call.id,
      userId: scenario.bUserId,
      mediaIncarnation: "inc_b",
      transportCapability: "p2p-v1",
      transferCapability: "transport-transfer-v1",
    })
    const transfer = await service.requestTransportTransfer({
      workspaceId: scenario.workspaceId,
      callId: started.call.id,
      userId: scenario.aUserId,
      endpointId: started.endpoint.id,
      target: "sfu",
      idempotencyKey: "cleanup",
    })
    await pool.query(
      `UPDATE call_transport_sessions SET provider_session_id = CASE
      WHEN transport_generation = 1 THEN 'cf_source_' || endpoint_id
      WHEN endpoint_id = $3 THEN 'cf_target_' || endpoint_id ELSE NULL END
      WHERE workspace_id = $1 AND call_id = $2`,
      [scenario.workspaceId, started.call.id, joined.endpoint.id]
    )
    const allocation = service.createEndpointCfSession({
      workspaceId: scenario.workspaceId,
      callId: started.call.id,
      userId: scenario.aUserId,
      endpointId: started.endpoint.id,
      mediaIncarnation: "inc_a",
      generation: transfer.transfer!.target.generation,
      sessionId: null,
    })
    await service.leaveCallAsUser({
      workspaceId: scenario.workspaceId,
      callId: started.call.id,
      userId: scenario.bUserId,
    })
    await service.leaveCallAsUser({
      workspaceId: scenario.workspaceId,
      callId: started.call.id,
      userId: scenario.aUserId,
    })
    releaseCreate()
    await expect(allocation).rejects.toMatchObject({ code: "CALL_STALE_INCARNATION" })

    expect(new Set(closed)).toEqual(
      new Set([
        `cf_source_${started.endpoint.id}`,
        `cf_source_${joined.endpoint.id}`,
        `cf_target_${joined.endpoint.id}`,
        "cf_inflight",
      ])
    )
    const open = await pool.query(
      `SELECT id FROM call_transport_sessions WHERE workspace_id = $1 AND call_id = $2 AND status <> 'closed'`,
      [scenario.workspaceId, started.call.id]
    )
    expect(open.rows).toEqual([])
  })

  test("should expose generation-qualified SFU publications on the roster and allow a peer pull", async () => {
    const scenario = await seedScenario()
    const pulled: Array<{ sessionId: string; tracks: Array<{ sessionId: string; trackName: string }> }> = []
    let sessionNumber = 0
    const service = new CallService({
      pool,
      featureFlagService: featureFlags,
      cloudflare: {
        createSession: async () => ({ sessionId: `cf_sfu_${++sessionNumber}` }),
        addLocalTracks: async (_sessionId: string, request: { tracks: Array<{ trackName: string }> }) => ({
          requiresImmediateRenegotiation: false,
          tracks: request.tracks.map(({ trackName }) => ({ trackName })),
        }),
        pullRemoteTracks: async (
          sessionId: string,
          request: { tracks: Array<{ sessionId: string; trackName: string }> }
        ) => {
          pulled.push({ sessionId, tracks: request.tracks })
          return { requiresImmediateRenegotiation: false, tracks: request.tracks }
        },
      } as never,
    })
    const started = await service.startCall({
      ...scenario,
      userId: scenario.aUserId,
      mode: "video",
      mediaIncarnation: "inc_publisher",
    })
    const joined = await service.joinCall({
      workspaceId: scenario.workspaceId,
      callId: started.call.id,
      userId: scenario.bUserId,
      mediaIncarnation: "inc_receiver",
    })
    const publisherSession = await service.createEndpointCfSession({
      workspaceId: scenario.workspaceId,
      callId: started.call.id,
      userId: scenario.aUserId,
      endpointId: started.endpoint.id,
      mediaIncarnation: "inc_publisher",
      generation: 1,
    })
    const receiverSession = await service.createEndpointCfSession({
      workspaceId: scenario.workspaceId,
      callId: started.call.id,
      userId: scenario.bUserId,
      endpointId: joined.endpoint.id,
      mediaIncarnation: "inc_receiver",
      generation: 1,
    })
    const published = await service.publishTracks({
      workspaceId: scenario.workspaceId,
      callId: started.call.id,
      userId: scenario.aUserId,
      endpointId: started.endpoint.id,
      mediaIncarnation: "inc_publisher",
      generation: 1,
      sessionId: publisherSession.cfSessionId,
      sdp: { type: "offer", sdp: "v=0" },
      tracks: [
        { kind: "mic", mid: "0", trackName: "publisher-mic" },
        { kind: "camera", mid: "1", trackName: "publisher-camera" },
      ],
    })
    const rosterPublisher = published.snapshot.roster.find((entry) => entry.endpointId === started.endpoint.id)
    const remoteTracks = rosterPublisher!.publishedTracks.map((track) => ({
      location: "remote" as const,
      sessionId: rosterPublisher!.cfSessionId!,
      trackName: track.trackName,
    }))

    await service.pullTracks({
      workspaceId: scenario.workspaceId,
      callId: started.call.id,
      userId: scenario.bUserId,
      endpointId: joined.endpoint.id,
      mediaIncarnation: "inc_receiver",
      generation: 1,
      sessionId: receiverSession.cfSessionId,
      tracks: remoteTracks,
    })

    expect({ rosterPublisher, pulled }).toEqual({
      rosterPublisher: expect.objectContaining({
        cfSessionId: publisherSession.cfSessionId,
        publishedTracks: [
          { kind: "mic", trackName: "publisher-mic", transportGeneration: 1 },
          { kind: "camera", trackName: "publisher-camera", transportGeneration: 1 },
        ],
      }),
      pulled: [{ sessionId: receiverSession.cfSessionId, tracks: remoteTracks }],
    })
  })

  test("should preserve publication revision when the SFU registry mutates without one", async () => {
    const scenario = await seedScenario()
    const service = new CallService({
      pool,
      featureFlagService: featureFlags,
      cloudflare: {
        createSession: async () => ({ sessionId: "cf_sfu" }),
        addLocalTracks: async () => ({
          requiresImmediateRenegotiation: false,
          tracks: [{ trackName: "mic" }],
        }),
      } as never,
    })
    const started = await service.startCall({
      ...scenario,
      userId: scenario.aUserId,
      mode: "video",
      mediaIncarnation: "inc_sfu",
    })
    await service.createEndpointCfSession({
      workspaceId: scenario.workspaceId,
      callId: started.call.id,
      userId: scenario.aUserId,
      endpointId: started.endpoint.id,
      mediaIncarnation: "inc_sfu",
    })

    await service.publishTracks({
      workspaceId: scenario.workspaceId,
      callId: started.call.id,
      userId: scenario.aUserId,
      endpointId: started.endpoint.id,
      mediaIncarnation: "inc_sfu",
      sdp: { type: "offer", sdp: "v=0" },
      tracks: [{ kind: "mic", mid: "0", trackName: "mic" }],
    })

    const persisted = await CallEndpointRepository.findById(pool, scenario.workspaceId, started.endpoint.id)
    expect({ revision: persisted?.publicationRevision, tracks: persisted?.publishedTracks }).toEqual({
      revision: 0,
      tracks: [{ kind: "mic", trackName: "mic" }],
    })
  })

  test("should start a target publication registry at revision zero after a mature source registry", async () => {
    const scenario = await seedScenario()
    const started = await calls.startCall({
      ...scenario,
      userId: scenario.aUserId,
      mode: "video",
      mediaIncarnation: "inc_a",
      transportCapability: "p2p-v1",
      transferCapability: "transport-transfer-v1",
      callsP2pEnabled: true,
      turnConfigured: true,
    })
    for (let revision = 1; revision <= 3; revision++) {
      await calls.setP2pPublications({
        workspaceId: scenario.workspaceId,
        callId: started.call.id,
        userId: scenario.aUserId,
        endpointId: started.endpoint.id,
        endpointEpoch: started.endpoint.epoch,
        endpointConnectionSeq: started.endpoint.connectionSeq,
        mediaIncarnation: "inc_a",
        generation: 1,
        revision,
        publications: [{ kind: "mic", publicationId: `source_mic_${revision}` }],
      })
    }

    const prepared = await calls.requestTransportTransfer({
      workspaceId: scenario.workspaceId,
      callId: started.call.id,
      userId: scenario.aUserId,
      endpointId: started.endpoint.id,
      target: "sfu",
      idempotencyKey: "fresh-target-registry",
    })
    const target = prepared.transfer!.sessions.find(
      (session) =>
        session.endpointId === started.endpoint.id && session.generation === prepared.transfer!.target.generation
    )

    expect({ revision: target?.publicationRevision, tracks: target?.publishedTracks }).toEqual({
      revision: 0,
      tracks: [],
    })
  })

  test("should assign a recovery deadline when the readiness barrier commits", async () => {
    const scenario = await seedScenario()
    const started = await calls.startCall({
      ...scenario,
      userId: scenario.aUserId,
      mode: "video",
      mediaIncarnation: "inc_a",
      transportCapability: "p2p-v1",
      transferCapability: "transport-transfer-v1",
    })
    const joined = await calls.joinCall({
      workspaceId: scenario.workspaceId,
      callId: started.call.id,
      userId: scenario.bUserId,
      mediaIncarnation: "inc_b",
      transportCapability: "p2p-v1",
      transferCapability: "transport-transfer-v1",
    })
    const prepared = await calls.requestTransportTransfer({
      workspaceId: scenario.workspaceId,
      callId: started.call.id,
      userId: scenario.aUserId,
      endpointId: started.endpoint.id,
      target: "p2p",
      idempotencyKey: "commit-deadline",
    })
    const joinedObligation = prepared.transfer!.obligations.find((item) => item.endpointId === joined.endpoint.id)!
    await pool.query(
      `UPDATE call_endpoints SET lease_expires_at = NOW() - INTERVAL '1 second'
      WHERE workspace_id = $1 AND id = $2`,
      [scenario.workspaceId, joined.endpoint.id]
    )
    await expect(
      calls.acknowledgeTransferReady({
        workspaceId: scenario.workspaceId,
        callId: started.call.id,
        userId: scenario.bUserId,
        transferId: prepared.transfer!.id,
        generation: prepared.transfer!.target.generation,
        endpointId: joined.endpoint.id,
        endpointEpoch: joined.endpoint.epoch,
        mediaIncarnation: "inc_b",
        membershipRevision: joinedObligation.membershipRevision,
        trackRevision: joinedObligation.trackRevision,
        ownPublicationsReady: true,
        readyPublications: joinedObligation.expectedPublications,
      })
    ).rejects.toMatchObject({ code: "CALL_STALE_ENDPOINT" })
    await pool.query(
      `UPDATE call_endpoints SET lease_expires_at = NOW() + INTERVAL '1 minute'
      WHERE workspace_id = $1 AND id = $2`,
      [scenario.workspaceId, joined.endpoint.id]
    )
    for (const [userId, endpoint, incarnation] of [
      [scenario.aUserId, started.endpoint, "inc_a"],
      [scenario.bUserId, joined.endpoint, "inc_b"],
    ] as const) {
      const obligation = prepared.transfer!.obligations.find((item) => item.endpointId === endpoint.id)!
      await calls.acknowledgeTransferReady({
        workspaceId: scenario.workspaceId,
        callId: started.call.id,
        userId,
        transferId: prepared.transfer!.id,
        generation: prepared.transfer!.target.generation,
        endpointId: endpoint.id,
        endpointEpoch: endpoint.epoch,
        mediaIncarnation: incarnation,
        membershipRevision: obligation.membershipRevision,
        trackRevision: obligation.trackRevision,
        ownPublicationsReady: true,
        readyPublications: obligation.expectedPublications,
      })
    }

    const row = await pool.query<{ phase: string; recovery_deadline: Date | null }>(
      `SELECT phase, recovery_deadline FROM call_transport_transfers WHERE workspace_id = $1 AND id = $2`,
      [scenario.workspaceId, prepared.transfer!.id]
    )
    expect({ phase: row.rows[0]?.phase, hasRecoveryDeadline: row.rows[0]?.recovery_deadline instanceof Date }).toEqual({
      phase: "committing",
      hasRecoveryDeadline: true,
    })
  })

  test("should complete, reverse, replay acknowledgements, and retain an abort target until source restoration", async () => {
    const scenario = await seedScenario()
    let sessionCounter = 0
    const closed: string[] = []
    const service = new CallService({
      pool,
      featureFlagService: featureFlags,
      turnIssuer: { issue: async () => ({ iceServers: [], expiresAt: new Date(Date.now() + 60_000).toISOString() }) },
      cloudflare: {
        createSession: async () => ({ sessionId: `cf_${++sessionCounter}` }),
        addLocalTracks: async (_sessionId: string, request: { tracks: Array<{ trackName: string }> }) => ({
          requiresImmediateRenegotiation: false,
          tracks: request.tracks.map(({ trackName }) => ({ trackName })),
          sessionDescription: { type: "answer", sdp: "v=0" },
        }),
        closeSession: async (sessionId: string) => {
          closed.push(sessionId)
        },
      } as never,
    })
    const started = await service.startCall({
      ...scenario,
      userId: scenario.aUserId,
      mode: "video",
      mediaIncarnation: "inc_a",
      transportCapability: "p2p-v1",
      transferCapability: "transport-transfer-v1",
      callsP2pEnabled: true,
      turnConfigured: true,
    })
    const joined = await service.joinCall({
      workspaceId: scenario.workspaceId,
      callId: started.call.id,
      userId: scenario.bUserId,
      mediaIncarnation: "inc_b",
      transportCapability: "p2p-v1",
      transferCapability: "transport-transfer-v1",
    })
    const identities = [
      { userId: scenario.aUserId, endpoint: started.endpoint, incarnation: "inc_a" },
      { userId: scenario.bUserId, endpoint: joined.endpoint, incarnation: "inc_b" },
    ]
    for (const identity of identities) {
      await service.setP2pPublications({
        workspaceId: scenario.workspaceId,
        callId: started.call.id,
        userId: identity.userId,
        endpointId: identity.endpoint.id,
        endpointEpoch: identity.endpoint.epoch,
        endpointConnectionSeq: identity.endpoint.connectionSeq,
        mediaIncarnation: identity.incarnation,
        generation: 1,
        revision: 1,
        publications: [{ kind: "mic", publicationId: `${identity.endpoint.id}_p2p_1` }],
      })
    }

    const acknowledgeAllReady = async (snapshot: Awaited<ReturnType<CallService["getRosterSnapshot"]>>) => {
      let current = snapshot
      for (const identity of identities) {
        const obligation = current.transfer!.obligations.find((item) => item.endpointId === identity.endpoint.id)!
        current = await service.acknowledgeTransferReady({
          workspaceId: scenario.workspaceId,
          callId: started.call.id,
          userId: identity.userId,
          transferId: current.transfer!.id,
          generation: current.transfer!.target.generation,
          endpointId: identity.endpoint.id,
          endpointEpoch: identity.endpoint.epoch,
          mediaIncarnation: identity.incarnation,
          membershipRevision: obligation.membershipRevision,
          trackRevision: obligation.trackRevision,
          ownPublicationsReady: true,
          readyPublications: obligation.expectedPublications,
        })
      }
      return current
    }
    const acknowledgeAllSwitched = async (snapshot: Awaited<ReturnType<CallService["getRosterSnapshot"]>>) => {
      let current = snapshot
      for (const identity of identities) {
        const obligation = current.transfer!.obligations.find((item) => item.endpointId === identity.endpoint.id)!
        const ack = {
          workspaceId: scenario.workspaceId,
          callId: started.call.id,
          userId: identity.userId,
          transferId: current.transfer!.id,
          generation: current.transfer!.target.generation,
          endpointId: identity.endpoint.id,
          endpointEpoch: identity.endpoint.epoch,
          mediaIncarnation: identity.incarnation,
          membershipRevision: obligation.membershipRevision,
          trackRevision: obligation.trackRevision,
        }
        current = await service.acknowledgeTransferSwitched(ack)
        await service.acknowledgeTransferSwitched(ack)
      }
      return current
    }

    let first = await service.requestTransportTransfer({
      workspaceId: scenario.workspaceId,
      callId: started.call.id,
      userId: scenario.aUserId,
      endpointId: started.endpoint.id,
      target: "sfu",
      idempotencyKey: "forward",
    })
    for (const identity of identities) {
      const generation = first.transfer!.target.generation
      const created = await service.createEndpointCfSession({
        workspaceId: scenario.workspaceId,
        callId: started.call.id,
        userId: identity.userId,
        endpointId: identity.endpoint.id,
        mediaIncarnation: identity.incarnation,
        generation,
      })
      await service.publishTracks({
        workspaceId: scenario.workspaceId,
        callId: started.call.id,
        userId: identity.userId,
        endpointId: identity.endpoint.id,
        mediaIncarnation: identity.incarnation,
        generation,
        sessionId: created.cfSessionId,
        sdp: { type: "offer", sdp: "v=0" },
        tracks: [{ kind: "mic", mid: "0", trackName: `${identity.endpoint.id}_sfu_2` }],
      })
    }
    first = await acknowledgeAllReady(await service.getRosterSnapshot(scenario.workspaceId, started.call.id))
    const churnIdentity = identities[0]!
    const churnSession = first.transfer!.sessions.find(
      (item) => item.endpointId === churnIdentity.endpoint.id && item.generation === first.transfer!.target.generation
    )!
    const beforeChurn = await service.getRosterSnapshot(scenario.workspaceId, started.call.id)
    const oldReceiverObligation = beforeChurn.transfer!.obligations.find(
      (item) => item.endpointId === joined.endpoint.id
    )!
    await service.publishTracks({
      workspaceId: scenario.workspaceId,
      callId: started.call.id,
      userId: churnIdentity.userId,
      endpointId: churnIdentity.endpoint.id,
      mediaIncarnation: churnIdentity.incarnation,
      generation: first.transfer!.target.generation,
      sessionId: churnSession.providerSessionId,
      sdp: { type: "offer", sdp: "v=0" },
      tracks: [{ kind: "mic", mid: "0", trackName: "a_sfu_replaced" }],
    })
    const afterChurn = await service.getRosterSnapshot(scenario.workspaceId, started.call.id)
    const currentReceiverObligation = afterChurn.transfer!.obligations.find(
      (item) => item.endpointId === joined.endpoint.id
    )!
    await expect(
      service.acknowledgeTransferReady({
        workspaceId: scenario.workspaceId,
        callId: started.call.id,
        userId: scenario.bUserId,
        transferId: afterChurn.transfer!.id,
        generation: afterChurn.transfer!.target.generation,
        endpointId: joined.endpoint.id,
        endpointEpoch: joined.endpoint.epoch,
        mediaIncarnation: "inc_b",
        membershipRevision: currentReceiverObligation.membershipRevision,
        trackRevision: currentReceiverObligation.trackRevision,
        ownPublicationsReady: true,
        readyPublications: [
          ...oldReceiverObligation.expectedPublications,
          ...currentReceiverObligation.expectedPublications,
        ],
      })
    ).rejects.toMatchObject({ code: "CALL_STALE_TRANSFER" })
    first = await acknowledgeAllReady(afterChurn)
    first = await acknowledgeAllSwitched(first)
    expect({
      phase: first.transfer?.phase,
      transport: first.mediaTransport,
      generation: first.transportGeneration,
    }).toEqual({
      phase: "completed",
      transport: "sfu",
      generation: 2,
    })

    let reverse = await service.requestTransportTransfer({
      workspaceId: scenario.workspaceId,
      callId: started.call.id,
      userId: scenario.aUserId,
      endpointId: started.endpoint.id,
      target: "p2p",
      idempotencyKey: "reverse",
    })
    for (const identity of identities) {
      await service.setP2pPublications({
        workspaceId: scenario.workspaceId,
        callId: started.call.id,
        userId: identity.userId,
        endpointId: identity.endpoint.id,
        endpointEpoch: identity.endpoint.epoch,
        endpointConnectionSeq: identity.endpoint.connectionSeq,
        mediaIncarnation: identity.incarnation,
        generation: reverse.transfer!.target.generation,
        revision: 1,
        publications: [{ kind: "mic", publicationId: `${identity.endpoint.id}_p2p_3` }],
      })
    }
    reverse = await acknowledgeAllReady(await service.getRosterSnapshot(scenario.workspaceId, started.call.id))
    const firstIdentity = identities[0]!
    const firstObligation = reverse.transfer!.obligations.find((item) => item.endpointId === firstIdentity.endpoint.id)!
    await service.acknowledgeTransferSwitched({
      workspaceId: scenario.workspaceId,
      callId: started.call.id,
      userId: firstIdentity.userId,
      transferId: reverse.transfer!.id,
      generation: reverse.transfer!.target.generation,
      endpointId: firstIdentity.endpoint.id,
      endpointEpoch: firstIdentity.endpoint.epoch,
      mediaIncarnation: firstIdentity.incarnation,
      membershipRevision: firstObligation.membershipRevision,
      trackRevision: firstObligation.trackRevision,
    })
    await service.sweepTransportTransfers(new Date(Date.now() + 120_000))
    let aborting = await service.getRosterSnapshot(scenario.workspaceId, started.call.id)
    expect({
      phase: aborting.transfer?.phase,
      transport: aborting.mediaTransport,
      targetSessionsOpen: aborting.transfer?.sessions.filter(
        (item) => item.generation === 3 && item.status !== "closed"
      ).length,
    }).toEqual({
      phase: "aborting",
      transport: "sfu",
      targetSessionsOpen: 2,
    })
    await service.sweepTransportTransfers(new Date(Date.now() + 240_000))
    aborting = await service.getRosterSnapshot(scenario.workspaceId, started.call.id)
    expect({
      phase: aborting.transfer?.phase,
      recoveryCode: aborting.transfer?.recoveryCode,
      targetSessionsOpen: aborting.transfer?.sessions.filter(
        (item) => item.generation === 3 && item.status !== "closed"
      ).length,
    }).toEqual({
      phase: "aborting",
      recoveryCode: "RESTORE_ACK_TIMEOUT",
      targetSessionsOpen: 2,
    })
    const restoringIdentity = identities[0]!
    const restoringObligation = aborting.transfer!.obligations.find(
      (item) => item.endpointId === restoringIdentity.endpoint.id
    )!
    aborting = await service.acknowledgeTransferRestored({
      workspaceId: scenario.workspaceId,
      callId: started.call.id,
      userId: restoringIdentity.userId,
      transferId: aborting.transfer!.id,
      generation: aborting.transfer!.target.generation,
      endpointId: restoringIdentity.endpoint.id,
      endpointEpoch: restoringIdentity.endpoint.epoch,
      mediaIncarnation: restoringIdentity.incarnation,
      membershipRevision: restoringObligation.membershipRevision,
      trackRevision: restoringObligation.trackRevision,
    })
    expect({
      phase: aborting.transfer?.phase,
      targetSessionsOpen: aborting.transfer?.sessions.filter(
        (item) => item.generation === 3 && item.status !== "closed"
      ).length,
    }).toEqual({
      phase: "aborting",
      targetSessionsOpen: 2,
    })
    await service.leaveCallAsUser({
      workspaceId: scenario.workspaceId,
      callId: started.call.id,
      userId: scenario.bUserId,
    })
    aborting = await service.acknowledgeTransferRestored({
      workspaceId: scenario.workspaceId,
      callId: started.call.id,
      userId: restoringIdentity.userId,
      transferId: aborting.transfer!.id,
      generation: aborting.transfer!.target.generation,
      endpointId: restoringIdentity.endpoint.id,
      endpointEpoch: restoringIdentity.endpoint.epoch,
      mediaIncarnation: restoringIdentity.incarnation,
      membershipRevision: restoringObligation.membershipRevision,
      trackRevision: restoringObligation.trackRevision,
    })
    expect({
      phase: aborting.transfer?.phase,
      transport: aborting.mediaTransport,
      targetSessionsOpen: aborting.transfer?.sessions.filter(
        (item) => item.generation === 3 && item.status !== "closed"
      ).length,
    }).toEqual({
      phase: "failed",
      transport: "sfu",
      targetSessionsOpen: 0,
    })
  })

  test("should fence the prior browser when the same endpoint and epoch bind a new media incarnation", async () => {
    const scenario = await seedScenario()
    const started = await calls.startCall({
      ...scenario,
      userId: scenario.aUserId,
      mode: "video",
      mediaIncarnation: "inc_old",
      transportCapability: "p2p-v1",
      transferCapability: "transport-transfer-v1",
      callsP2pEnabled: true,
      turnConfigured: true,
    })
    const joined = await calls.joinCall({
      workspaceId: scenario.workspaceId,
      callId: started.call.id,
      userId: scenario.bUserId,
      mediaIncarnation: "inc_peer",
      transportCapability: "p2p-v1",
      transferCapability: "transport-transfer-v1",
    })
    await calls.setP2pPublications({
      workspaceId: scenario.workspaceId,
      callId: started.call.id,
      userId: scenario.aUserId,
      endpointId: started.endpoint.id,
      endpointEpoch: started.endpoint.epoch,
      endpointConnectionSeq: started.endpoint.connectionSeq,
      mediaIncarnation: "inc_old",
      generation: 1,
      revision: 1,
      publications: [{ kind: "mic", publicationId: "pub_old" }],
    })
    await calls.markEndpointReconnecting({
      workspaceId: scenario.workspaceId,
      endpointId: started.endpoint.id,
      epoch: started.endpoint.epoch,
      connectionSeq: started.endpoint.connectionSeq,
    })
    const rebound = await calls.joinCall({
      workspaceId: scenario.workspaceId,
      callId: started.call.id,
      userId: scenario.aUserId,
      mediaIncarnation: "inc_new",
      transportCapability: "p2p-v1",
    })

    const persisted = await CallEndpointRepository.findById(pool, scenario.workspaceId, started.endpoint.id)
    expect({
      identity: {
        endpointId: rebound.endpoint.id,
        epoch: rebound.endpoint.epoch,
        mediaIncarnation: rebound.endpoint.mediaIncarnation,
      },
      publicationState: persisted && { revision: persisted.publicationRevision, tracks: persisted.publishedTracks },
    }).toEqual({
      identity: { endpointId: started.endpoint.id, epoch: started.endpoint.epoch, mediaIncarnation: "inc_new" },
      publicationState: { revision: 0, tracks: [] },
    })

    await expect(
      calls.validateP2pSignal({
        workspaceId: scenario.workspaceId,
        callId: started.call.id,
        userId: scenario.aUserId,
        senderEndpointId: started.endpoint.id,
        senderEpoch: started.endpoint.epoch,
        senderIncarnation: "inc_old",
        senderConnectionSeq: started.endpoint.connectionSeq,
        recipientEndpointId: joined.endpoint.id,
        recipientEpoch: joined.endpoint.epoch,
        recipientMediaIncarnation: "inc_peer",
        generation: 1,
      })
    ).rejects.toMatchObject({ code: "CALL_STALE_ENDPOINT" })
  })
})
