import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test"
import { Pool } from "pg"
import { Visibilities } from "@threahq/types"
import { setupTestDatabase, withTransaction, addTestMember } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { FeatureFlagOverrideRepository, FeatureFlagService } from "../../src/features/feature-flags"
import { StreamService } from "../../src/features/streams"
import { CallService } from "../../src/features/calls"
import { CallTransferRepository } from "../../src/features/calls/transfer-repository"
import { workspaceId as newWorkspaceId } from "../../src/lib/id"

let pool: Pool
let calls: CallService

beforeAll(async () => {
  pool = await setupTestDatabase()
  calls = new CallService({
    pool,
    featureFlagService: new FeatureFlagService(pool),
    turnIssuer: { issue: async () => ({ iceServers: [], expiresAt: new Date(Date.now() + 60_000).toISOString() }) },
  })
})

afterEach(() => mock.restore())

afterAll(async () => {
  await pool.end()
})

async function startTransfer() {
  const workspaceId = newWorkspaceId()
  const { aUserId, bUserId } = await withTransaction(pool, async (client) => {
    await WorkspaceRepository.insert(client, {
      id: workspaceId,
      name: "Transfer version",
      slug: `xfer-${workspaceId}`,
      createdBy: workspaceId,
    })
    const members = {
      aUserId: (await addTestMember(client, workspaceId, "xfer-a")).id,
      bUserId: (await addTestMember(client, workspaceId, "xfer-b")).id,
    }
    await FeatureFlagOverrideRepository.replaceForSubject(client, workspaceId, "workspace", workspaceId, {
      callsP2p: "on",
    })
    return members
  })
  const stream = await new StreamService(pool).createChannel({
    workspaceId,
    slug: `xfer-${workspaceId}`,
    displayName: "Transfer version",
    createdBy: aUserId,
    visibility: Visibilities.PRIVATE,
    memberIds: [bUserId],
  })
  const started = await calls.startCall({
    workspaceId,
    streamId: stream.id,
    userId: aUserId,
    mode: "video",
    mediaIncarnation: "inc_a",
    transportCapability: "p2p-v1",
    transferCapability: "transport-transfer-v1",
  })
  const joined = await calls.joinCall({
    workspaceId,
    callId: started.call.id,
    userId: bUserId,
    mediaIncarnation: "inc_b",
    transportCapability: "p2p-v1",
    transferCapability: "transport-transfer-v1",
  })
  const prepared = await calls.requestTransportTransfer({
    workspaceId,
    callId: started.call.id,
    userId: aUserId,
    endpointId: started.endpoint.id,
    target: "p2p",
    idempotencyKey: "transfer-version",
  })
  const transfer = prepared.transfer!
  const ack = (userId: string, endpoint: { id: string; epoch: number }, mediaIncarnation: string) => {
    const obligation = transfer.obligations.find((item) => item.endpointId === endpoint.id)!
    return {
      identity: {
        workspaceId,
        callId: started.call.id,
        userId,
        transferId: transfer.id,
        generation: transfer.target.generation,
        endpointId: endpoint.id,
        endpointEpoch: endpoint.epoch,
        mediaIncarnation,
        membershipRevision: obligation.membershipRevision,
        trackRevision: obligation.trackRevision,
      },
      expectedPublications: obligation.expectedPublications,
    }
  }
  const stored = async () => {
    const row = await CallTransferRepository.findById(pool, workspaceId, transfer.id)
    return { phase: row?.phase, version: row?.version }
  }
  const publishOnTarget = (publicationId: string) =>
    calls.setP2pPublications({
      workspaceId,
      callId: started.call.id,
      userId: bUserId,
      endpointId: joined.endpoint.id,
      endpointEpoch: joined.endpoint.epoch,
      endpointConnectionSeq: joined.endpoint.connectionSeq,
      mediaIncarnation: "inc_b",
      generation: transfer.target.generation,
      revision: 1,
      publications: [{ kind: "mic", publicationId }],
    })
  const currentExpected = async (endpointId: string) => {
    const snapshot = await calls.getRosterSnapshot(workspaceId, started.call.id)
    return snapshot.transfer!.obligations.find((item) => item.endpointId === endpointId)!.expectedPublications
  }
  return {
    transfer,
    stored,
    publishOnTarget,
    currentExpected,
    a: ack(aUserId, started.endpoint, "inc_a"),
    b: ack(bUserId, joined.endpoint, "inc_b"),
  }
}

type Party = Awaited<ReturnType<typeof startTransfer>>["a"]

const ready = (party: Party, readyPublications = party.expectedPublications) =>
  calls.acknowledgeTransferReady({ ...party.identity, ownPublicationsReady: true, readyPublications })

describe("call transfer version ordering", () => {
  test("should bump the transfer version once per obligation change and leave replayed acknowledgements idempotent", async () => {
    const { transfer, stored, a, b } = await startTransfer()

    await ready(a)
    const readyOnce = await stored()
    await ready(a)
    const readyReplayed = await stored()
    await Promise.all([ready(a), ready(b)])
    const committed = await stored()
    const firstSwitched = await calls.acknowledgeTransferSwitched(a.identity)
    const afterFirstSwitched = await stored()
    await Promise.all([calls.acknowledgeTransferSwitched(a.identity), calls.acknowledgeTransferSwitched(b.identity)])
    const completed = await stored()
    const terminalReplay = await calls.acknowledgeTransferSwitched(b.identity)

    expect({
      readyOnce,
      readyReplayed,
      committed,
      firstSwitchedResponse: { phase: firstSwitched.transfer?.phase, version: firstSwitched.transfer?.version },
      afterFirstSwitched,
      completed,
      terminalReplay: { phase: terminalReplay.transfer?.phase, version: terminalReplay.transfer?.version },
      afterTerminalReplay: await stored(),
    }).toEqual({
      readyOnce: { phase: "preparing", version: transfer.version + 1 },
      readyReplayed: { phase: "preparing", version: transfer.version + 1 },
      // B's ready touch plus preparing → committing; A's concurrent replay adds nothing
      committed: { phase: "committing", version: transfer.version + 3 },
      firstSwitchedResponse: { phase: "committing", version: transfer.version + 4 },
      afterFirstSwitched: { phase: "committing", version: transfer.version + 4 },
      // B's switched touch plus committing → draining → completed; A's concurrent replay adds nothing
      completed: { phase: "completed", version: transfer.version + 7 },
      terminalReplay: { phase: "completed", version: transfer.version + 7 },
      afterTerminalReplay: { phase: "completed", version: transfer.version + 7 },
    })
  })

  test("should still fail an expired preparing transfer when an acknowledgement lands between listing and locking", async () => {
    const { stored, a } = await startTransfer()
    const listExpired = CallTransferRepository.listExpired
    spyOn(CallTransferRepository, "listExpired").mockImplementation(async (db, now) => {
      const expired = await listExpired(db, now)
      await ready(a)
      return expired
    })

    await calls.sweepTransportTransfers(new Date(Date.now() + 120_000))

    expect((await stored()).phase).toBe("failed")
  })

  test("should bump the version when a ready acknowledgement follows a publication change", async () => {
    const { transfer, stored, publishOnTarget, currentExpected, a } = await startTransfer()

    await ready(a)
    await publishOnTarget("xfer_b_mic")
    const afterPublish = await stored()
    await ready(a, await currentExpected(a.identity.endpointId))

    expect({ afterPublish, afterReady: await stored() }).toEqual({
      afterPublish: { phase: "preparing", version: transfer.version + 2 },
      afterReady: { phase: "preparing", version: transfer.version + 3 },
    })
  })

  test("should leave the version unchanged for replayed restored acknowledgements and on failed transfers", async () => {
    const aborted = await startTransfer()
    const failed = await startTransfer()
    await Promise.all([ready(aborted.a), ready(aborted.b)])
    await calls.sweepTransportTransfers(new Date(Date.now() + 120_000))
    const aborting = await aborted.stored()
    const failedBefore = await failed.stored()

    await calls.acknowledgeTransferRestored(aborted.a.identity)
    const restoredOnce = await aborted.stored()
    await calls.acknowledgeTransferRestored(aborted.a.identity)
    await calls.acknowledgeTransferRestored(failed.a.identity)

    expect({
      aborting: aborting.phase,
      restoredOnce,
      restoredReplayed: await aborted.stored(),
      failedBefore: failedBefore.phase,
      failedAfterRestore: await failed.stored(),
    }).toEqual({
      aborting: "aborting",
      restoredOnce: { phase: "aborting", version: aborting.version! + 1 },
      restoredReplayed: { phase: "aborting", version: aborting.version! + 1 },
      failedBefore: "failed",
      failedAfterRestore: failedBefore,
    })
  })
})
