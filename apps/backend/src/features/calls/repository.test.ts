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
    // Workspace-correlated so the anti-join seeks UNIQUE (workspace_id, call_id, user_id).
    expect(sql).toContain("p.workspace_id = c.workspace_id")
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
    expect(sql).toContain("p.workspace_id = c.workspace_id")
  })

  it("endActiveIfEmpty CASes active → ended only when no joined participant remains (explicit last-leave)", async () => {
    const captured: Captured = { text: "" }
    await CallRepository.endActiveIfEmpty(createQuerier(captured), {
      workspaceId: "ws_1",
      id: "call_1",
      reason: "completed",
    })
    const sql = normalize(captured.text)
    expect(sql).toContain("status = 'ended'")
    expect(sql).toContain("ended_at = NOW()")
    // Same CAS guard as enterGraceIfEmpty — a status flag AND a live-roster
    // predicate (INV-20), so a concurrent join / double last-leave ends once.
    expect(sql).toContain("c.status = 'active'")
    expect(sql).toMatch(/NOT EXISTS \([^)]*call_participants p[\s\S]*status = 'joined'/)
    expect(sql).toContain("p.workspace_id = c.workspace_id")
  })

  it("enterGraceIfEmptyBatch cascades reaped emptiness with a workspace-correlated anti-join", async () => {
    const captured: Captured = { text: "" }
    await CallRepository.enterGraceIfEmptyBatch(createQuerier(captured), {
      callIds: ["call_1", "call_2"],
      graceDeadline: NOW,
    })
    const sql = normalize(captured.text)
    expect(sql).toContain("ended_reason = 'reaped'")
    expect(sql).toContain("c.id = ANY")
    expect(sql).toMatch(/NOT EXISTS \([^)]*call_participants p[\s\S]*status = 'joined'/)
    expect(sql).toContain("p.workspace_id = c.workspace_id")
  })

  it("lockForUpdateInOrder locks the calls FOR UPDATE in id order (call→endpoint reap order)", async () => {
    const captured: Captured = { text: "" }
    await CallRepository.lockForUpdateInOrder(createQuerier(captured), ["call_2", "call_1"])
    const sql = normalize(captured.text)
    expect(sql).toContain("FROM calls")
    expect(sql).toContain("id = ANY")
    expect(sql).toContain("ORDER BY id")
    expect(sql).toContain("FOR UPDATE")
  })

  it("findCallStartedEventId resolves the chat anchor by stream + call_started + payload callId", async () => {
    const captured: Captured = { text: "" }
    const id = await CallRepository.findCallStartedEventId(
      createQuerier(captured, [{ id: "event_chat_1" }]),
      "stream_1",
      "call_1"
    )
    expect(id).toBe("event_chat_1")
    const sql = normalize(captured.text)
    expect(sql).toContain("FROM stream_events")
    expect(sql).toContain("stream_id =")
    expect(sql).toContain("event_type = 'call_started'")
    expect(sql).toContain("payload->>'callId' =")
  })

  it("findCallStartedEventId returns null when no matching card exists", async () => {
    const captured: Captured = { text: "" }
    const id = await CallRepository.findCallStartedEventId(createQuerier(captured, []), "stream_1", "call_1")
    expect(id).toBeNull()
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

describe("CallEndpointRepository — rebind clears stale media + bumps the connection seq", () => {
  it("clears cf_session_id + published_tracks only when the incarnation changes, keeping them otherwise", async () => {
    const captured: Captured = { text: "" }
    await CallEndpointRepository.rebind(createQuerier(captured, [{}]), {
      workspaceId: "ws_1",
      id: "callep_1",
      mediaIncarnation: "inc_new",
      leaseExpiresAt: NOW,
    })
    const sql = normalize(captured.text)
    // A reload's new incarnation drops the previous incarnation's dead CF session
    // and track registry; a same-incarnation reconnect keeps both (the ELSE arm).
    expect(sql).toMatch(
      /cf_session_id = CASE WHEN media_incarnation IS DISTINCT FROM \$\d+ THEN NULL ELSE cf_session_id END/
    )
    expect(sql).toMatch(
      /published_tracks = CASE WHEN media_incarnation IS DISTINCT FROM \$\d+ THEN '\[\]'::jsonb ELSE published_tracks END/
    )
  })

  it("bumps connection_seq on every bind so a stale disconnect demotion no-ops", async () => {
    const captured: Captured = { text: "" }
    await CallEndpointRepository.rebind(createQuerier(captured, [{}]), {
      workspaceId: "ws_1",
      id: "callep_1",
      mediaIncarnation: "inc_1",
      leaseExpiresAt: NOW,
    })
    const sql = normalize(captured.text)
    expect(sql).toContain("connection_seq = connection_seq + 1")
  })

  it("markReconnecting fences the demotion on (id, epoch, connection_seq, live status)", async () => {
    const captured: Captured = { text: "" }
    await CallEndpointRepository.markReconnecting(createQuerier(captured), {
      workspaceId: "ws_1",
      id: "callep_1",
      epoch: 3,
      connectionSeq: 5,
    })
    const sql = normalize(captured.text)
    expect(sql).toContain("SET status = 'reconnecting'")
    expect(sql).toContain("epoch =")
    expect(sql).toContain("connection_seq =")
    expect(sql).toContain("status = 'connected'")
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

  it("findLapsedCallIds reads distinct lapsed-endpoint call ids without locking", async () => {
    const captured: Captured = { text: "" }
    await CallEndpointRepository.findLapsedCallIds(createQuerier(captured), NOW)
    const sql = normalize(captured.text)
    expect(sql).toContain("SELECT DISTINCT call_id")
    expect(sql).toContain("status IN ('connected', 'reconnecting')")
    expect(sql).toContain("lease_expires_at <=")
    expect(sql).not.toContain("FOR UPDATE")
  })

  it("reapLapsed closes only live lapsed endpoints scoped to the locked calls", async () => {
    const captured: Captured = { text: "" }
    await CallEndpointRepository.reapLapsed(createQuerier(captured), NOW, ["call_1", "call_2"])
    const sql = normalize(captured.text)
    expect(sql).toContain("call_id = ANY")
    expect(sql).toContain("status IN ('connected', 'reconnecting')")
    expect(sql).toContain("lease_expires_at <=")
    expect(sql).toContain("SET status = 'closed'")
  })

  it("reapLapsed is a no-op with no locked calls (never a global endpoint scan)", async () => {
    const captured: Captured = { text: "" }
    const rows = await CallEndpointRepository.reapLapsed(createQuerier(captured), NOW, [])
    expect(rows).toEqual([])
    expect(captured.text).toBe("")
  })
})

describe("CallEndpointRepository — post-CF writes fenced on media_incarnation (S5)", () => {
  it("setMediaState CASes on (id, media_incarnation, live status) so a stale incarnation matches nothing", async () => {
    const captured: Captured = { text: "" }
    await CallEndpointRepository.setMediaState(createQuerier(captured), {
      workspaceId: "ws_1",
      id: "callep_1",
      mediaIncarnation: "inc_1",
      mediaState: { muted: true },
    })
    const sql = normalize(captured.text)
    expect(sql).toContain("SET media_state =")
    expect(sql).toContain("media_incarnation =")
    expect(sql).toContain("status IN ('connected', 'reconnecting')")
  })

  it("setPublishedTracks CASes on (id, media_incarnation, live status)", async () => {
    const captured: Captured = { text: "" }
    await CallEndpointRepository.setPublishedTracks(createQuerier(captured), {
      workspaceId: "ws_1",
      id: "callep_1",
      mediaIncarnation: "inc_1",
      publishedTracks: [{ kind: "mic", trackName: "mic0" }],
    })
    const sql = normalize(captured.text)
    expect(sql).toContain("SET published_tracks =")
    expect(sql).toContain("media_incarnation =")
    expect(sql).toContain("status IN ('connected', 'reconnecting')")
  })
})

describe("CallEndpointRepository — live-endpoint pull-authorization set (S1)", () => {
  it("listLiveByCall reads the call's connected/reconnecting endpoints, workspace-scoped", async () => {
    const captured: Captured = { text: "" }
    await CallEndpointRepository.listLiveByCall(createQuerier(captured), "ws_1", "call_1")
    const sql = normalize(captured.text)
    expect(sql).toContain("FROM call_endpoints")
    expect(sql).toContain("workspace_id =")
    expect(sql).toContain("call_id =")
    expect(sql).toContain("status IN ('connected', 'reconnecting')")
  })
})

describe("CallParticipantRepository — endpoint liveness anti-join", () => {
  it("markLeftWhereNoLiveEndpoint workspace-correlates the endpoint anti-join", async () => {
    const captured: Captured = { text: "" }
    await CallParticipantRepository.markLeftWhereNoLiveEndpoint(createQuerier(captured), ["callp_1"])
    const sql = normalize(captured.text)
    expect(sql).toContain("SET status = 'left'")
    expect(sql).toMatch(/NOT EXISTS \([^)]*call_endpoints e[\s\S]*status IN \('connected', 'reconnecting'\)/)
    expect(sql).toContain("e.workspace_id = p.workspace_id")
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

describe("CallParticipantRepository — roster carries the publisher's CF session", () => {
  it("listRoster selects and maps cf_session_id so clients can address peer media", async () => {
    const captured: Captured = { text: "" }
    const roster = await CallParticipantRepository.listRoster(
      createQuerier(captured, [
        {
          participant_id: "callp_1",
          user_id: "usr_1",
          participant_status: "joined",
          endpoint_id: "callep_1",
          endpoint_status: "connected",
          cf_session_id: "cfsess_abc",
          media_state: {},
          published_tracks: [{ kind: "mic", trackName: "t1" }],
        },
      ]),
      "ws_1",
      "call_1"
    )
    expect(normalize(captured.text)).toContain("cf_session_id")
    expect(roster[0]).toMatchObject({ endpointId: "callep_1", cfSessionId: "cfsess_abc" })
  })
})
