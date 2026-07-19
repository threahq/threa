import { describe, expect, it, mock } from "bun:test"
import type { QueryConfig, QueryResult } from "pg"
import type { Querier } from "../../db"
import {
  CallRepository,
  CallParticipantRepository,
  CallEndpointRepository,
  CallInvitationRepository,
} from "./repository"

// SQL-capture tests (house style — enclave invocations-repository.test.ts): the
// load-bearing race guards are in the WHERE clauses, so assert the queries the
// repo builds carry them. The mocked-service tests exercise the branch behavior;
// these pin the concurrency invariants that make those branches correct.

interface Captured {
  text: string
}

function createQuerier(captured: Captured, rows: unknown[] = []): Querier {
  return {
    query: mock(async (q) => {
      captured.text = (q as QueryConfig).text
      return { rows, rowCount: rows.length } as QueryResult
    }),
  }
}

const NOW = new Date("2026-07-19T12:00:00.000Z")

/** Collapse whitespace so fragment asserts don't fight the query's formatting. */
function normalize(sql: string): string {
  return sql.replace(/\s+/g, " ").trim()
}

describe("CallRepository — active-call glare + grace re-verification", () => {
  it("insertIfNoActiveCall conflicts on the active-per-stream partial index and does nothing", async () => {
    const captured: Captured = { text: "" }
    await CallRepository.insertIfNoActiveCall(createQuerier(captured), {
      id: "call_1",
      workspaceId: "ws_1",
      streamId: "stream_1",
      startedBy: "usr_a",
      mode: "video",
      mediaTransport: "sfu",
    })
    const sql = normalize(captured.text)
    expect(sql).toContain("ON CONFLICT (workspace_id, stream_id) WHERE status IN ('active', 'empty_grace')")
    expect(sql).toContain("DO NOTHING")
  })

  it("endGraceExpired re-verifies emptiness so a revived call is never ended (join-vs-reap)", async () => {
    const captured: Captured = { text: "" }
    await CallRepository.endGraceExpired(createQuerier(captured), NOW)
    const sql = normalize(captured.text)
    expect(sql).toContain("status = 'empty_grace'")
    expect(sql).toContain("grace_deadline <=")
    expect(sql).toMatch(/NOT EXISTS \([^)]*call_participants p[\s\S]*status = 'joined'/)
  })

  it("enterGraceIfEmpty only graces an active call with no joined participant", async () => {
    const captured: Captured = { text: "" }
    await CallRepository.enterGraceIfEmpty(createQuerier(captured), {
      workspaceId: "ws_1",
      id: "call_1",
      graceDeadline: NOW,
      reason: "completed",
    })
    const sql = normalize(captured.text)
    expect(sql).toContain("c.status = 'active'")
    expect(sql).toMatch(/NOT EXISTS \([^)]*call_participants p[\s\S]*status = 'joined'/)
  })
})

describe("CallParticipantRepository — actor-conditional admission", () => {
  it("admit revives left/joined but excludes removed from the conflict update", async () => {
    const captured: Captured = { text: "" }
    await CallParticipantRepository.admit(createQuerier(captured, [{}]), {
      id: "callp_1",
      workspaceId: "ws_1",
      callId: "call_1",
      userId: "usr_a",
      invitedBy: null,
    })
    const sql = normalize(captured.text)
    expect(sql).toContain("ON CONFLICT (workspace_id, call_id, user_id) DO UPDATE")
    expect(sql).toContain("WHERE call_participants.status <> 'removed'")
  })
})

describe("CallEndpointRepository — lease fencing + lapse-only reap", () => {
  it("renewLease is fenced on (id, epoch, live status)", async () => {
    const captured: Captured = { text: "" }
    await CallEndpointRepository.renewLease(createQuerier(captured), {
      workspaceId: "ws_1",
      id: "callep_1",
      epoch: 4,
      leaseExpiresAt: NOW,
    })
    const sql = normalize(captured.text)
    expect(sql).toContain("epoch =")
    expect(sql).toContain("status IN ('connected', 'reconnecting')")
  })

  it("reapLapsed closes only live endpoints past their lease", async () => {
    const captured: Captured = { text: "" }
    await CallEndpointRepository.reapLapsed(createQuerier(captured), NOW)
    const sql = normalize(captured.text)
    expect(sql).toContain("status IN ('connected', 'reconnecting')")
    expect(sql).toContain("lease_expires_at <=")
    expect(sql).toContain("SET status = 'closed'")
  })
})

describe("CallInvitationRepository — expire only past-due rings", () => {
  it("expireStaleRings CASes ringing → expired for past-due rows only", async () => {
    const captured: Captured = { text: "" }
    await CallInvitationRepository.expireStaleRings(createQuerier(captured), NOW)
    const sql = normalize(captured.text)
    expect(sql).toContain("status = 'expired'")
    expect(sql).toContain("WHERE status = 'ringing'")
    expect(sql).toContain("expires_at <=")
  })

  it("decline CASes ringing → declined for the invitee only", async () => {
    const captured: Captured = { text: "" }
    await CallInvitationRepository.decline(createQuerier(captured), {
      workspaceId: "ws_1",
      id: "callinv_1",
      inviteeUserId: "usr_peer",
    })
    const sql = normalize(captured.text)
    expect(sql).toContain("status = 'declined'")
    expect(sql).toContain("invitee_user_id =")
    expect(sql).toContain("status = 'ringing'")
  })
})
