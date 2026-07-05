import { describe, it, expect } from "vitest"
import type { CachedEvent } from "@/db"
import { resolveBoardEventRows } from "./board-event-rows"

let seq = 0
function cachedEvent(
  partial: Partial<CachedEvent> & { eventType: CachedEvent["eventType"]; createdAt: string }
): CachedEvent {
  seq += 1
  return {
    id: partial.id ?? `evt_${seq}`,
    workspaceId: "ws_1",
    streamId: partial.streamId ?? "stream_1",
    sequence: String(seq),
    _sequenceNum: seq,
    eventType: partial.eventType,
    payload: partial.payload ?? {},
    actorId: partial.actorId ?? null,
    actorType: partial.actorType ?? null,
    createdAt: partial.createdAt,
    _cachedAt: seq,
  }
}

const CONV = "conv_1"

describe("resolveBoardEventRows", () => {
  it("keeps a memo capture whose payload names this conversation, drops others", () => {
    const events = [
      cachedEvent({
        id: "m_here",
        eventType: "memos:captured",
        createdAt: "2026-07-04T10:00:00Z",
        payload: { conversationId: CONV },
      }),
      cachedEvent({
        id: "m_other",
        eventType: "memos:captured",
        createdAt: "2026-07-04T10:01:00Z",
        payload: { conversationId: "conv_other" },
      }),
    ]
    const rows = resolveBoardEventRows(events, { conversationId: CONV, memberMessageIds: new Set() })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: "memo", key: "m_here" })
  })

  it("marks a scheduled follow-up cancelled when a matching cancel event is present", () => {
    const events = [
      cachedEvent({
        id: "f1",
        eventType: "agent:follow_up_scheduled",
        createdAt: "2026-07-04T10:00:00Z",
        payload: { followUpId: "fup_1", sourceConversationId: CONV },
      }),
      cachedEvent({
        id: "f2",
        eventType: "agent:follow_up_scheduled",
        createdAt: "2026-07-04T10:01:00Z",
        payload: { followUpId: "fup_2", sourceConversationId: CONV },
      }),
      cachedEvent({
        eventType: "agent:follow_up_cancelled",
        createdAt: "2026-07-04T10:02:00Z",
        payload: { followUpId: "fup_1" },
      }),
    ]
    const rows = resolveBoardEventRows(events, { conversationId: CONV, memberMessageIds: new Set() })
    const followUps = rows.filter((r) => r.kind === "followUp")
    expect(followUps).toHaveLength(2)
    expect(followUps.find((r) => r.key === "f1")).toMatchObject({ cancelled: true })
    expect(followUps.find((r) => r.key === "f2")).toMatchObject({ cancelled: false })
  })

  it("groups a session's lifecycle events into one row iff its trigger is a member", () => {
    const events = [
      cachedEvent({
        eventType: "agent_session:started",
        createdAt: "2026-07-04T10:00:00Z",
        payload: { sessionId: "sess_A", triggerMessageId: "msg_member" },
      }),
      cachedEvent({
        eventType: "agent_session:completed",
        createdAt: "2026-07-04T10:00:30Z",
        payload: { sessionId: "sess_A" },
      }),
      // A second session whose trigger is NOT a conversation member — excluded.
      cachedEvent({
        eventType: "agent_session:started",
        createdAt: "2026-07-04T10:05:00Z",
        payload: { sessionId: "sess_B", triggerMessageId: "msg_outsider" },
      }),
    ]
    const rows = resolveBoardEventRows(events, {
      conversationId: CONV,
      memberMessageIds: new Set(["msg_member"]),
    })
    const sessions = rows.filter((r) => r.kind === "session")
    expect(sessions).toHaveLength(1)
    // Keyed by the trigger slot (like the timeline), not the raw session id.
    expect(sessions[0]).toMatchObject({ kind: "session", key: "trigger:msg_member" })
    if (sessions[0].kind === "session") expect(sessions[0].events).toHaveLength(2)
  })

  it("collapses a superseded re-run to the latest session in the trigger slot (no duplicate card)", () => {
    // An invoking-message edit reruns the agent: SAME triggerMessageId, NEW
    // sessionId, no deleted tombstone. The old completed trace must NOT linger as
    // a second card — the timeline replaces the slot in place, so the board does too.
    const events = [
      cachedEvent({
        eventType: "agent_session:started",
        createdAt: "2026-07-04T10:00:00Z",
        payload: { sessionId: "sess_old", triggerMessageId: "msg_member" },
      }),
      cachedEvent({
        eventType: "agent_session:completed",
        createdAt: "2026-07-04T10:00:30Z",
        payload: { sessionId: "sess_old" },
      }),
      cachedEvent({
        eventType: "agent_session:started",
        createdAt: "2026-07-04T10:05:00Z",
        payload: { sessionId: "sess_new", triggerMessageId: "msg_member" },
      }),
    ]
    const rows = resolveBoardEventRows(events, { conversationId: CONV, memberMessageIds: new Set(["msg_member"]) })
    const sessions = rows.filter((r) => r.kind === "session")
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({ key: "trigger:msg_member" })
    // The surviving card is the NEW (running) session, not the stale completed one.
    if (sessions[0].kind === "session") {
      const sessionIds = new Set(sessions[0].events.map((e) => (e.payload as { sessionId: string }).sessionId))
      expect(sessionIds).toEqual(new Set(["sess_new"]))
    }
  })

  it("returns rows ordered by time across kinds", () => {
    const events = [
      cachedEvent({
        id: "late_memo",
        eventType: "memos:captured",
        createdAt: "2026-07-04T12:00:00Z",
        payload: { conversationId: CONV },
      }),
      cachedEvent({
        eventType: "agent_session:started",
        createdAt: "2026-07-04T09:00:00Z",
        payload: { sessionId: "sess_A", triggerMessageId: "msg_member" },
      }),
    ]
    const rows = resolveBoardEventRows(events, { conversationId: CONV, memberMessageIds: new Set(["msg_member"]) })
    expect(rows.map((r) => r.kind)).toEqual(["session", "memo"])
  })
})
