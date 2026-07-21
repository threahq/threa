/**
 * DB-backed leave/end lifecycle (chunk 2 — fix/calls-auto-end). Drives the real
 * CallService against threa_test so the `endActiveIfEmpty` CAS, the in-tx
 * `stream:call_ended` outbox write, and the FOR UPDATE serialization are
 * exercised for real — not through mocks.
 *
 * Values are produced through the repo's own NOW()/status path and read back
 * through the repo (INV-66); assertions are on event presence + payload content,
 * not raw counts (INV-23). Control-plane only: no Cloudflare (channel calls never
 * ring, and leave closes no CF session when none was minted).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { Visibilities } from "@threa/types"
import { setupTestDatabase, withTransaction, addTestMember } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamService } from "../../src/features/streams"
import { CallService, CallRepository, ENDPOINT_LEASE_TTL_MS } from "../../src/features/calls"
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

interface Scenario {
  workspaceId: string
  streamId: string
  aUserId: string
  bUserId: string
}

/** A fresh workspace + private channel with members A (creator) and B. */
async function seedScenario(label: string): Promise<Scenario> {
  const workspaceId = newWorkspaceId()
  let aUserId = ""
  let bUserId = ""
  await withTransaction(pool, async (client) => {
    await WorkspaceRepository.insert(client, {
      id: workspaceId,
      name: `Calls ${label}`,
      slug: `calls-${label}-${workspaceId}`,
      createdBy: workspaceId,
    })
    aUserId = (await addTestMember(client, workspaceId, `a-${label}`)).id
    bUserId = (await addTestMember(client, workspaceId, `b-${label}`)).id
  })
  const channel = await streams.createChannel({
    workspaceId,
    slug: `calls-${label}-${workspaceId}`,
    displayName: `Calls ${label}`,
    createdBy: aUserId,
    visibility: Visibilities.PRIVATE,
    memberIds: [bUserId],
  })
  return { workspaceId, streamId: channel.id, aUserId, bUserId }
}

/** The `stream:call_ended` outbox payloads for a call (event presence + content). */
async function callEndedRows(callId: string): Promise<Array<{ callId: string; streamId: string }>> {
  const res = await pool.query<{ payload: { callId: string; streamId: string } }>(
    `SELECT payload FROM outbox WHERE event_type = 'stream:call_ended' AND payload->>'callId' = $1`,
    [callId]
  )
  return res.rows.map((r) => r.payload)
}

describe("calls — explicit last-leave ends promptly (fix/calls-auto-end)", () => {
  test("leaveCall by the last participant ends the call in-tx and writes stream:call_ended", async () => {
    const s = await seedScenario("leavecall")
    const started = await calls.startCall({
      workspaceId: s.workspaceId,
      streamId: s.streamId,
      userId: s.aUserId,
      mode: "video",
    })

    await calls.leaveCall({
      workspaceId: s.workspaceId,
      callId: started.call.id,
      userId: s.aUserId,
      endpointId: started.endpoint.id,
    })

    const ended = await CallRepository.findById(pool, s.workspaceId, started.call.id)
    expect(ended).toMatchObject({ status: "ended", endedReason: "completed" })
    expect(ended?.endedAt).not.toBeNull()

    const rows = await callEndedRows(started.call.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ callId: started.call.id, streamId: s.streamId })
  })

  test("leaveCallAsUser by the last participant ends the call in-tx and writes stream:call_ended", async () => {
    const s = await seedScenario("leaveasuser")
    const started = await calls.startCall({
      workspaceId: s.workspaceId,
      streamId: s.streamId,
      userId: s.aUserId,
      mode: "video",
    })

    await calls.leaveCallAsUser({ workspaceId: s.workspaceId, callId: started.call.id, userId: s.aUserId })

    const ended = await CallRepository.findById(pool, s.workspaceId, started.call.id)
    expect(ended).toMatchObject({ status: "ended", endedReason: "completed" })

    const rows = await callEndedRows(started.call.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ callId: started.call.id, streamId: s.streamId })
  })

  test("a leave that still leaves others joined keeps the call active and writes no call_ended", async () => {
    const s = await seedScenario("stayactive")
    const started = await calls.startCall({
      workspaceId: s.workspaceId,
      streamId: s.streamId,
      userId: s.aUserId,
      mode: "video",
    })
    await calls.joinCall({ workspaceId: s.workspaceId, callId: started.call.id, userId: s.bUserId })

    await calls.leaveCall({
      workspaceId: s.workspaceId,
      callId: started.call.id,
      userId: s.aUserId,
      endpointId: started.endpoint.id,
    })

    const after = await CallRepository.findById(pool, s.workspaceId, started.call.id)
    expect(after?.status).toBe("active")
    expect(await callEndedRows(started.call.id)).toHaveLength(0)
  })

  test("concurrent double last-leave ends exactly once, no error on the loser", async () => {
    const s = await seedScenario("doubleleave")
    const started = await calls.startCall({
      workspaceId: s.workspaceId,
      streamId: s.streamId,
      userId: s.aUserId,
      mode: "video",
    })

    // Two racing self-leaves for the same last participant (double-click / two
    // devices). The call-row FOR UPDATE serializes them; the ended-guard + the CAS
    // together end it once and no-op the loser.
    const results = await Promise.allSettled([
      calls.leaveCallAsUser({ workspaceId: s.workspaceId, callId: started.call.id, userId: s.aUserId }),
      calls.leaveCallAsUser({ workspaceId: s.workspaceId, callId: started.call.id, userId: s.aUserId }),
    ])
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"])

    const ended = await CallRepository.findById(pool, s.workspaceId, started.call.id)
    expect(ended?.status).toBe("ended")
    // Exactly one end event — the CAS + status guard prevent a double append.
    expect(await callEndedRows(started.call.id)).toHaveLength(1)
  })

  test("disconnect/reaper path still enters empty_grace, never immediate-end (regression guard)", async () => {
    const s = await seedScenario("reapergrace")
    const started = await calls.startCall({
      workspaceId: s.workspaceId,
      streamId: s.streamId,
      userId: s.aUserId,
      mode: "video",
    })

    // A socket drop is not a leave: the lease reaper cascades emptiness to
    // empty_grace (its reconnect buffer), NOT to ended. Reap with a now past the
    // fresh lease so the just-minted endpoint lapses.
    await calls.reapLapsedEndpoints(new Date(Date.now() + ENDPOINT_LEASE_TTL_MS + 60_000))

    const after = await CallRepository.findById(pool, s.workspaceId, started.call.id)
    expect(after).toMatchObject({ status: "empty_grace", endedReason: "reaped" })
    // Grace has not ended it yet, so no call_ended was written by the reaper.
    expect(await callEndedRows(started.call.id)).toHaveLength(0)
  })
})
