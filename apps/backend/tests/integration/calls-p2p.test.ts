import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Pool } from "pg"
import { Visibilities } from "@threahq/types"
import { setupTestDatabase, withTransaction, addTestMember } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamService } from "../../src/features/streams"
import { CallService, CallRepository, CallEndpointRepository } from "../../src/features/calls"
import { workspaceId as newWorkspaceId } from "../../src/lib/id"

let pool: Pool
let streams: StreamService
let calls: CallService

beforeAll(async () => {
  pool = await setupTestDatabase()
  streams = new StreamService(pool)
  calls = new CallService({ pool })
})

afterAll(async () => {
  await pool.end()
})

async function seedScenario() {
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
    }
    const sfu = await service.startCall(params)
    await expect(
      service.issueTurnCredentials({ ...params, callId: sfu.call.id, endpointId: sfu.endpoint.id })
    ).rejects.toMatchObject({ code: "CALL_P2P_UNAVAILABLE" })
    await service.leaveCallAsUser({ workspaceId: scenario.workspaceId, callId: sfu.call.id, userId: scenario.aUserId })
    const p2p = await service.startCall({ ...params, allowP2p: true })
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

  test("should persist transport capability and generation-qualified publications in the real schema", async () => {
    const scenario = await seedScenario()
    const started = await calls.startCall({
      ...scenario,
      userId: scenario.aUserId,
      mode: "video",
      mediaIncarnation: "inc_a",
      transportCapability: "p2p-v1",
      allowP2p: true,
    })
    const joined = await calls.joinCall({
      workspaceId: scenario.workspaceId,
      callId: started.call.id,
      userId: scenario.bUserId,
      mediaIncarnation: "inc_b",
      transportCapability: "p2p-v1",
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

  test("should fence the prior browser when the same endpoint and epoch bind a new media incarnation", async () => {
    const scenario = await seedScenario()
    const started = await calls.startCall({
      ...scenario,
      userId: scenario.aUserId,
      mode: "video",
      mediaIncarnation: "inc_old",
      transportCapability: "p2p-v1",
      allowP2p: true,
    })
    const joined = await calls.joinCall({
      workspaceId: scenario.workspaceId,
      callId: started.call.id,
      userId: scenario.bUserId,
      mediaIncarnation: "inc_peer",
      transportCapability: "p2p-v1",
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
