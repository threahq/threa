import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { Visibilities } from "@threahq/types"
import { addTestMember, setupTestDatabase, withTransaction } from "./setup"
import {
  CallEndpointRepository,
  CallInvitationRepository,
  CallParticipantRepository,
  CallRepository,
  CallService,
  ENDPOINT_LEASE_TTL_MS,
} from "../../src/features/calls"
import { FeatureFlagService } from "../../src/features/feature-flags"
import { StreamService } from "../../src/features/streams"
import { WorkspaceRepository } from "../../src/features/workspaces"
import {
  callEndpointId,
  callId,
  callInvitationId,
  callParticipantId,
  eventId,
  streamId,
  userId,
  workspaceId,
} from "../../src/lib/id"

const MINUTE_MS = 60_000

describe("Calls workspace scope (INV-8)", () => {
  let pool: Pool
  let streams: StreamService
  let calls: CallService

  let wsA: string
  let wsB: string

  beforeAll(async () => {
    pool = await setupTestDatabase()
    streams = new StreamService(pool)
    calls = new CallService({ pool, featureFlagService: new FeatureFlagService(pool) })
    wsA = workspaceId()
    wsB = workspaceId()
  })

  afterAll(async () => {
    await pool.end()
  })

  async function seedCall(wid: string, options: { status?: string; graceDeadline?: Date } = {}) {
    const id = callId()
    await pool.query(
      `INSERT INTO calls (id, workspace_id, stream_id, started_by, status, mode, grace_deadline)
       VALUES ($1, $2, $3, $4, $5, 'video', $6)`,
      [id, wid, streamId(), userId(), options.status ?? "active", options.graceDeadline ?? null]
    )
    return id
  }

  async function seedParticipant(wid: string, call: string, status = "joined") {
    const id = callParticipantId()
    await pool.query(
      `INSERT INTO call_participants (id, workspace_id, call_id, user_id, status) VALUES ($1, $2, $3, $4, $5)`,
      [id, wid, call, userId(), status]
    )
    return id
  }

  async function seedEndpoint(wid: string, call: string, participant: string, leaseExpiresAt: Date) {
    const id = callEndpointId()
    await pool.query(
      `INSERT INTO call_endpoints (id, workspace_id, call_id, participant_id, epoch, status, lease_expires_at)
       VALUES ($1, $2, $3, $4, 1, 'connected', $5)`,
      [id, wid, call, participant, leaseExpiresAt]
    )
    return id
  }

  async function seedInvitation(wid: string, call: string) {
    const id = callInvitationId()
    await pool.query(
      `INSERT INTO call_invitations (id, workspace_id, call_id, invitee_user_id, inviter_user_id, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, 'ringing', $6)`,
      [id, wid, call, userId(), userId(), new Date(Date.now() + 10 * MINUTE_MS)]
    )
    return id
  }

  async function seedCallStartedEvent(wid: string, stream: string, call: string, sequence: number) {
    const id = eventId()
    await pool.query(
      `INSERT INTO stream_events (id, workspace_id, stream_id, sequence, event_type, payload)
       VALUES ($1, $2, $3, $4, 'call_started', $5)`,
      [id, wid, stream, sequence, JSON.stringify({ callId: call })]
    )
    return id
  }

  async function callRow(id: string) {
    const result = await pool.query<{ workspace_id: string; status: string; roster_version: number }>(
      `SELECT workspace_id, status, roster_version FROM calls WHERE id = $1`,
      [id]
    )
    return result.rows[0]
  }

  async function statusOf(table: "call_endpoints" | "call_participants" | "call_invitations", id: string) {
    const result = await pool.query<{ status: string }>(`SELECT status FROM ${table} WHERE id = $1`, [id])
    return result.rows[0]?.status
  }

  async function statusesOf(table: "call_endpoints" | "call_participants", ids: string[]) {
    return Promise.all(ids.map((id) => statusOf(table, id)))
  }

  async function lockedCallIds(ids: string[]) {
    const free = await pool.query<{ id: string }>(
      `SELECT id FROM calls WHERE id = ANY($1::text[]) FOR UPDATE SKIP LOCKED`,
      [ids]
    )
    return ids.filter((id) => !free.rows.some((row) => row.id === id)).sort()
  }

  test("should resolve the call_started event in the caller's workspace when another workspace holds a card for the same stream and call", async () => {
    const stream = streamId()
    const call = callId()
    const foreignEvent = await seedCallStartedEvent(wsB, stream, call, 1)
    const ownEvent = await seedCallStartedEvent(wsA, stream, call, 2)

    expect({
      own: await CallRepository.findCallStartedEventId(pool, wsA, stream, call),
      foreign: await CallRepository.findCallStartedEventId(pool, wsB, stream, call),
    }).toEqual({ own: ownEvent, foreign: foreignEvent })
  })

  test("should lock only the calls whose workspace and id both match a ref", async () => {
    const callA = await seedCall(wsA)
    const callB = await seedCall(wsB)
    const holder = await pool.connect()
    try {
      await holder.query("BEGIN")
      await CallRepository.lockForUpdateInOrder(holder, [
        { workspaceId: wsB, callId: callA },
        { workspaceId: wsA, callId: callB },
      ])
      const afterMismatch = await lockedCallIds([callA, callB])

      await CallRepository.lockForUpdateInOrder(holder, [{ workspaceId: wsA, callId: callA }])
      const afterMatch = await lockedCallIds([callA, callB])

      expect({ afterMismatch, afterMatch }).toEqual({ afterMismatch: [], afterMatch: [callA] })
    } finally {
      await holder.query("ROLLBACK")
      holder.release()
    }
  })

  test("should grace only the call a (workspace, id) ref names, ignoring a joined participant row from another workspace", async () => {
    const callA = await seedCall(wsA)
    const callB = await seedCall(wsB)
    await seedParticipant(wsB, callA)
    const graceDeadline = new Date(Date.now() + 5 * MINUTE_MS)

    const mismatched = await CallRepository.enterGraceIfEmptyBatch(pool, {
      refs: [{ workspaceId: wsB, callId: callA }],
      graceDeadline,
    })
    const matched = await CallRepository.enterGraceIfEmptyBatch(pool, {
      refs: [{ workspaceId: wsA, callId: callA }],
      graceDeadline,
    })

    expect({
      mismatched,
      matched: matched.map((call) => ({ id: call.id, workspaceId: call.workspaceId, status: call.status })),
      callA: await callRow(callA),
      callB: await callRow(callB),
    }).toEqual({
      mismatched: [],
      matched: [{ id: callA, workspaceId: wsA, status: "empty_grace" }],
      callA: { workspace_id: wsA, status: "empty_grace", roster_version: 0 },
      callB: { workspace_id: wsB, status: "active", roster_version: 0 },
    })
  })

  test("should end an expired grace call when another workspace holds a joined participant row for its id", async () => {
    const callA = await seedCall(wsA, { status: "empty_grace", graceDeadline: new Date(Date.now() - MINUTE_MS) })
    await seedParticipant(wsB, callA)

    const ended = await CallRepository.endGraceExpired(pool, new Date())

    expect(ended.filter((call) => call.id === callA).map((call) => ({ workspaceId: call.workspaceId }))).toEqual([
      { workspaceId: wsA },
    ])
    expect((await callRow(callA)).status).toBe("ended")
  })

  test("should bump the roster version only of the call a (workspace, id) ref names", async () => {
    const callA = await seedCall(wsA)
    const callB = await seedCall(wsB)

    await CallRepository.bumpRosterVersionBatch(pool, [{ workspaceId: wsB, callId: callA }])
    const afterMismatch = [(await callRow(callA)).roster_version, (await callRow(callB)).roster_version]
    await CallRepository.bumpRosterVersionBatch(pool, [{ workspaceId: wsA, callId: callA }])
    const afterMatch = [(await callRow(callA)).roster_version, (await callRow(callB)).roster_version]

    expect({ afterMismatch, afterMatch }).toEqual({ afterMismatch: [0, 0], afterMatch: [1, 0] })
  })

  test("should cancel only the ringing invitations of the workspace a ref names when another workspace holds one for the same call id", async () => {
    const call = callId()
    const own = await seedInvitation(wsA, call)
    const foreign = await seedInvitation(wsB, call)

    const cancelled = await CallInvitationRepository.cancelRingingForCalls(pool, [{ workspaceId: wsA, callId: call }])

    expect({
      cancelled: cancelled.map((invitation) => ({ id: invitation.id, workspaceId: invitation.workspaceId })),
      own: await statusOf("call_invitations", own),
      foreign: await statusOf("call_invitations", foreign),
    }).toEqual({
      cancelled: [{ id: own, workspaceId: wsA }],
      own: "cancelled",
      foreign: "ringing",
    })
  })

  test("should mark left only the participants a ref names, ignoring a live endpoint row from another workspace", async () => {
    const callA = callId()
    const callB = callId()
    const idleA = await seedParticipant(wsA, callA)
    const connectedA = await seedParticipant(wsA, callA)
    const idleB = await seedParticipant(wsB, callB)
    const lease = new Date(Date.now() + 5 * MINUTE_MS)
    await seedEndpoint(wsA, callA, connectedA, lease)
    await seedEndpoint(wsB, callB, idleA, lease)

    const mismatched = await CallParticipantRepository.markLeftWhereNoLiveEndpoint(pool, [
      { workspaceId: wsB, participantId: idleA },
    ])
    const matched = await CallParticipantRepository.markLeftWhereNoLiveEndpoint(pool, [
      { workspaceId: wsA, participantId: idleA },
      { workspaceId: wsA, participantId: connectedA },
    ])

    expect({
      mismatched,
      matched: matched.map((participant) => ({ id: participant.id, workspaceId: participant.workspaceId })),
      statuses: await statusesOf("call_participants", [idleA, connectedA, idleB]),
    }).toEqual({
      mismatched: [],
      matched: [{ id: idleA, workspaceId: wsA }],
      statuses: ["left", "joined", "joined"],
    })
  })

  test("should reap lapsed endpoints only on the calls a (workspace, id) ref names, leaving another workspace's endpoint for the same call id live", async () => {
    const callA = callId()
    const callB = callId()
    const now = new Date()
    const lapsed = new Date(now.getTime() - MINUTE_MS)
    const ownLapsed = await seedEndpoint(wsA, callA, callParticipantId(), lapsed)
    const ownFresh = await seedEndpoint(wsA, callA, callParticipantId(), new Date(now.getTime() + 5 * MINUTE_MS))
    const foreignSameCall = await seedEndpoint(wsB, callA, callParticipantId(), lapsed)
    const foreignOwnCall = await seedEndpoint(wsB, callB, callParticipantId(), lapsed)

    const discovered = await CallEndpointRepository.findLapsedCallIds(pool, now)
    const reapedA = await CallEndpointRepository.reapLapsed(pool, now, [{ workspaceId: wsA, callId: callA }])
    const afterA = await statusesOf("call_endpoints", [ownLapsed, ownFresh, foreignSameCall, foreignOwnCall])
    const reapedB = await CallEndpointRepository.reapLapsed(pool, now, [{ workspaceId: wsB, callId: callB }])

    expect(discovered).toEqual(
      expect.arrayContaining([
        { workspaceId: wsA, callId: callA },
        { workspaceId: wsB, callId: callA },
        { workspaceId: wsB, callId: callB },
      ])
    )
    expect({
      reapedA: reapedA.map((endpoint) => ({
        id: endpoint.id,
        workspaceId: endpoint.workspaceId,
        status: endpoint.status,
      })),
      afterA,
      reapedB: reapedB.map((endpoint) => ({ id: endpoint.id, workspaceId: endpoint.workspaceId })),
      foreignSameCallAfterB: await statusOf("call_endpoints", foreignSameCall),
    }).toEqual({
      reapedA: [{ id: ownLapsed, workspaceId: wsA, status: "closed" }],
      afterA: ["closed", "connected", "connected", "connected"],
      reapedB: [{ id: foreignOwnCall, workspaceId: wsB }],
      foreignSameCallAfterB: "connected",
    })
  })

  describe("lease reaper across workspaces", () => {
    async function seedWorkspaceWithCall(label: string) {
      const wid = workspaceId()
      let host = ""
      await withTransaction(pool, async (client) => {
        await WorkspaceRepository.insert(client, {
          id: wid,
          name: `Calls scope ${label}`,
          slug: `calls-scope-${label}-${wid}`,
          createdBy: wid,
        })
        host = (await addTestMember(client, wid, `host-${label}`)).id
      })
      const channel = await streams.createChannel({
        workspaceId: wid,
        slug: `calls-scope-${label}-${wid}`,
        createdBy: host,
        visibility: Visibilities.PRIVATE,
      })
      const started = await calls.startCall({ workspaceId: wid, streamId: channel.id, userId: host, mode: "video" })
      return { workspaceId: wid, callId: started.call.id }
    }

    test("should grace the lapsed call of every workspace and leave a call whose lease is live untouched", async () => {
      const first = await seedWorkspaceWithCall("reap-a")
      const second = await seedWorkspaceWithCall("reap-b")
      const bystander = await seedWorkspaceWithCall("reap-live")
      await pool.query(
        `UPDATE call_endpoints SET lease_expires_at = now() + interval '1 day' WHERE workspace_id = $1 AND call_id = $2`,
        [bystander.workspaceId, bystander.callId]
      )

      await calls.reapLapsedEndpoints(new Date(Date.now() + ENDPOINT_LEASE_TTL_MS + MINUTE_MS))

      expect({
        first: await CallRepository.findById(pool, first.workspaceId, first.callId),
        second: await CallRepository.findById(pool, second.workspaceId, second.callId),
        bystander: await CallRepository.findById(pool, bystander.workspaceId, bystander.callId),
      }).toEqual({
        first: expect.objectContaining({ id: first.callId, status: "empty_grace", endedReason: "reaped" }),
        second: expect.objectContaining({ id: second.callId, status: "empty_grace", endedReason: "reaped" }),
        bystander: expect.objectContaining({ id: bystander.callId, status: "active" }),
      })
    })
  })
})
