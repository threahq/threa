import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test"
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

afterEach(() => {
  ;(CallTransferRepository.listExpired as unknown as { mockRestore?: () => void }).mockRestore?.()
})

afterAll(async () => {
  await pool.end()
})

async function startTransfer() {
  const workspaceId = newWorkspaceId()
  let aUserId = ""
  let bUserId = ""
  await withTransaction(pool, async (client) => {
    await WorkspaceRepository.insert(client, {
      id: workspaceId,
      name: "Transfer version",
      slug: `xfer-${workspaceId}`,
      createdBy: workspaceId,
    })
    aUserId = (await addTestMember(client, workspaceId, "xfer-a")).id
    bUserId = (await addTestMember(client, workspaceId, "xfer-b")).id
    await FeatureFlagOverrideRepository.replaceForSubject(client, workspaceId, "workspace", workspaceId, {
      callsP2p: "on",
    })
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
    const result = await pool.query<{ phase: string; version: number }>(
      `SELECT phase, version FROM call_transport_transfers WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, transfer.id]
    )
    return result.rows[0]!
  }
  return {
    transfer,
    stored,
    a: ack(aUserId, started.endpoint, "inc_a"),
    b: ack(bUserId, joined.endpoint, "inc_b"),
  }
}

describe("call transfer version ordering", () => {
  test("should bump the transfer version on every acknowledgement and still commit and complete under concurrent acks", async () => {
    const { transfer, stored, a, b } = await startTransfer()
    const ready = (party: typeof a) =>
      calls.acknowledgeTransferReady({
        ...party.identity,
        ownPublicationsReady: true,
        readyPublications: party.expectedPublications,
      })

    await Promise.all([ready(a), ready(b)])
    const committed = await stored()
    const firstSwitched = await calls.acknowledgeTransferSwitched(a.identity)
    const afterFirstSwitched = await stored()
    await Promise.all([calls.acknowledgeTransferSwitched(a.identity), calls.acknowledgeTransferSwitched(b.identity)])
    const completed = await stored()

    expect({
      committed,
      firstSwitchedResponse: { phase: firstSwitched.transfer?.phase, version: firstSwitched.transfer?.version },
      afterFirstSwitched,
      completed,
    }).toEqual({
      // two ready touches plus preparing → committing
      committed: { phase: "committing", version: transfer.version + 3 },
      firstSwitchedResponse: { phase: "committing", version: transfer.version + 4 },
      afterFirstSwitched: { phase: "committing", version: transfer.version + 4 },
      // two switched touches plus committing → draining → completed
      completed: { phase: "completed", version: transfer.version + 8 },
    })
  })

  test("should still fail an expired preparing transfer when an acknowledgement lands between listing and locking", async () => {
    const { stored, a } = await startTransfer()
    const listExpired = CallTransferRepository.listExpired
    spyOn(CallTransferRepository, "listExpired").mockImplementation(async (db, now) => {
      const expired = await listExpired(db, now)
      await calls.acknowledgeTransferReady({
        ...a.identity,
        ownPublicationsReady: true,
        readyPublications: a.expectedPublications,
      })
      return expired
    })

    await calls.sweepTransportTransfers(new Date(Date.now() + 120_000))

    expect((await stored()).phase).toBe("failed")
  })
})
