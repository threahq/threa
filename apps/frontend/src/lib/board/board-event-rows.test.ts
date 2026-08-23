import { describe, it, expect } from "vitest"
import { BOARD_EVENT_ROW_TYPES, EVENT_TYPES, STREAM_ROW_SPEC, type EventType } from "@threa/types"
import type { CachedEvent } from "@/db"
import { BOARD_RAIL_EVENT_TYPES } from "./board-rail-event-types"
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

  it("places a memo with no conversation id by its source messages, and nowhere else", () => {
    // A memo saved before boundary extraction assigned its source message carries
    // `conversationId: undefined`, and the payload is immutable — provenance is the
    // only way it ever lands on a board surface.
    const events = [
      cachedEvent({
        id: "m_unassigned",
        eventType: "memos:captured",
        createdAt: "2026-07-04T10:00:00Z",
        payload: { memos: [{ memoId: "memo_1", title: "T", knowledgeType: "fact", sourceMessageIds: ["msg_2"] }] },
      }),
      cachedEvent({
        id: "m_elsewhere",
        eventType: "memos:captured",
        createdAt: "2026-07-04T10:01:00Z",
        payload: { memos: [{ memoId: "memo_2", title: "T", knowledgeType: "fact", sourceMessageIds: ["msg_9"] }] },
      }),
    ]
    const rows = resolveBoardEventRows(events, {
      conversationId: CONV,
      memberMessageIds: new Set(["msg_1", "msg_2"]),
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: "memo", key: "m_unassigned" })
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

  it("resolves a delegation created from this conversation into a row, dropping one from another", () => {
    const events = [
      cachedEvent({
        id: "d_here",
        eventType: "delegation:created",
        createdAt: "2026-07-04T10:00:00Z",
        payload: { delegationId: "dlg_1", title: "Ship it", sourceConversationId: CONV },
      }),
      cachedEvent({
        id: "d_other",
        eventType: "delegation:created",
        createdAt: "2026-07-04T10:01:00Z",
        payload: { delegationId: "dlg_2", title: "Elsewhere", sourceConversationId: "conv_other" },
      }),
    ]
    const rows = resolveBoardEventRows(events, { conversationId: CONV, memberMessageIds: new Set() })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: "delegation", key: "d_here", statusPatch: undefined })
  })

  it("carries the latest delegation:status_changed payload onto its delegation row", () => {
    const events = [
      cachedEvent({
        id: "d1",
        eventType: "delegation:created",
        createdAt: "2026-07-04T10:00:00Z",
        payload: { delegationId: "dlg_1", title: "Ship it", sourceConversationId: CONV },
      }),
      cachedEvent({
        eventType: "delegation:status_changed",
        createdAt: "2026-07-04T10:01:00Z",
        payload: { delegationId: "dlg_1", status: "claimed", claimedByLabel: "Kris's MacBook" },
      }),
      cachedEvent({
        eventType: "delegation:status_changed",
        createdAt: "2026-07-04T10:02:00Z",
        payload: { delegationId: "dlg_1", status: "completed", resultMessageId: "msg_result" },
      }),
      // Another delegation's patch must not leak onto this row.
      cachedEvent({
        eventType: "delegation:status_changed",
        createdAt: "2026-07-04T10:03:00Z",
        payload: { delegationId: "dlg_2", status: "failed" },
      }),
    ]
    const rows = resolveBoardEventRows(events, { conversationId: CONV, memberMessageIds: new Set() })
    expect(rows).toEqual([
      {
        kind: "delegation",
        key: "d1",
        sortMs: new Date("2026-07-04T10:00:00Z").getTime(),
        streamId: "stream_1",
        event: events[0],
        statusPatch: { delegationId: "dlg_1", status: "completed", resultMessageId: "msg_result" },
      },
    ])
  })

  it("keeps the max-createdAt status patch when the patches arrive out of array order", () => {
    // The board picks the latest patch by createdAt, deliberately unlike the
    // timeline's collector, which takes last-in-array. Only a reversed feed
    // distinguishes the two — every other patch case seeds ascending time.
    const created = cachedEvent({
      id: "d1",
      eventType: "delegation:created",
      createdAt: "2026-07-04T10:00:00Z",
      payload: { delegationId: "dlg_1", title: "Ship it", sourceConversationId: CONV },
    })
    const later = cachedEvent({
      eventType: "delegation:status_changed",
      createdAt: "2026-07-04T10:02:00Z",
      payload: { delegationId: "dlg_1", status: "completed", resultMessageId: "msg_result" },
    })
    const earlier = cachedEvent({
      eventType: "delegation:status_changed",
      createdAt: "2026-07-04T10:01:00Z",
      payload: { delegationId: "dlg_1", status: "claimed", claimedByLabel: "Kris's MacBook" },
    })
    const rows = resolveBoardEventRows([created, later, earlier], {
      conversationId: CONV,
      memberMessageIds: new Set(),
    })
    expect(rows).toEqual([
      {
        kind: "delegation",
        key: "d1",
        sortMs: new Date("2026-07-04T10:00:00Z").getTime(),
        streamId: "stream_1",
        event: created,
        statusPatch: { delegationId: "dlg_1", status: "completed", resultMessageId: "msg_result" },
      },
    ])
  })
})

describe("resolveBoardEventRows command chips", () => {
  const ME = "usr_me"

  function dispatched(overrides: { id?: string; commandId: string; conversationId?: string; actorId?: string }) {
    return cachedEvent({
      id: overrides.id,
      eventType: "command_dispatched",
      createdAt: "2026-07-04T10:00:00Z",
      actorId: overrides.actorId ?? ME,
      payload: {
        commandId: overrides.commandId,
        name: "compact",
        args: "",
        status: "dispatched",
        ...(overrides.conversationId ? { conversationId: overrides.conversationId } : {}),
      },
    })
  }

  it("groups a dispatched+completed pair into one row on the conversation the dispatch names", () => {
    const events = [
      dispatched({ id: "cmd_evt", commandId: "cmd_1", conversationId: CONV }),
      cachedEvent({
        id: "cmd_done",
        eventType: "command_completed",
        createdAt: "2026-07-04T10:00:09Z",
        actorId: ME,
        payload: { commandId: "cmd_1" },
      }),
    ]
    const rows = resolveBoardEventRows(events, {
      conversationId: CONV,
      memberMessageIds: new Set(),
      currentUserId: ME,
    })
    expect(rows).toEqual([
      {
        kind: "command",
        key: "cmd_1",
        sortMs: new Date("2026-07-04T10:00:00Z").getTime(),
        streamId: "stream_1",
        events,
      },
    ])
  })

  it("joins a command_failed event to its dispatched row", () => {
    const events = [
      dispatched({ id: "cmd_evt_f", commandId: "cmd_fail", conversationId: CONV }),
      cachedEvent({
        id: "cmd_bad",
        eventType: "command_failed",
        createdAt: "2026-07-04T10:00:07Z",
        actorId: ME,
        payload: { commandId: "cmd_fail", error: "boom" },
      }),
    ]
    const rows = resolveBoardEventRows(events, {
      conversationId: CONV,
      memberMessageIds: new Set(),
      currentUserId: ME,
    })
    expect(rows).toEqual([
      {
        kind: "command",
        key: "cmd_fail",
        sortMs: new Date("2026-07-04T10:00:00Z").getTime(),
        streamId: "stream_1",
        events,
      },
    ])
  })

  it("excludes another member's command", () => {
    const rows = resolveBoardEventRows(
      [dispatched({ commandId: "cmd_2", conversationId: CONV, actorId: "usr_other" })],
      {
        conversationId: CONV,
        memberMessageIds: new Set(),
        currentUserId: ME,
      }
    )
    expect(rows).toEqual([])
  })

  it("draws nothing for a stream-level (refless) dispatch — the timeline composer's commands stay off cards", () => {
    const rows = resolveBoardEventRows(
      [
        dispatched({ commandId: "cmd_3" }),
        cachedEvent({
          eventType: "command_completed",
          createdAt: "2026-07-04T10:00:09Z",
          actorId: ME,
          payload: { commandId: "cmd_3" },
        }),
      ],
      { conversationId: CONV, memberMessageIds: new Set(), currentUserId: ME }
    )
    expect(rows).toEqual([])
  })
})

const MEMBER_MESSAGE = "msg_member"

/**
 * The minimal event set that must produce a row for each spec-declared
 * conversation-scoped type. Session lifecycle types share one fixture whose
 * `started` names a member trigger — the group is one row.
 */
const SESSION_FIXTURE: CachedEvent[] = [
  cachedEvent({
    eventType: "agent_session:started",
    createdAt: "2026-07-04T10:00:00Z",
    payload: { sessionId: "sess_fixture", triggerMessageId: MEMBER_MESSAGE },
  }),
]

const USER = "usr_me"

const COMMAND_FIXTURE: CachedEvent[] = [
  cachedEvent({
    eventType: "command_dispatched",
    createdAt: "2026-07-04T10:00:00Z",
    actorId: USER,
    payload: { commandId: "cmd_fixture", name: "compact", args: "", status: "dispatched", conversationId: CONV },
  }),
  cachedEvent({
    eventType: "command_completed",
    createdAt: "2026-07-04T10:00:05Z",
    actorId: USER,
    payload: { commandId: "cmd_fixture" },
  }),
]

const COMMAND_FAILED_FIXTURE: CachedEvent[] = [
  COMMAND_FIXTURE[0],
  cachedEvent({
    eventType: "command_failed",
    createdAt: "2026-07-04T10:00:06Z",
    actorId: USER,
    payload: { commandId: "cmd_fixture", error: "boom" },
  }),
]

const ROW_FIXTURES: Partial<Record<EventType, CachedEvent[]>> = {
  command_dispatched: COMMAND_FIXTURE,
  command_completed: COMMAND_FIXTURE,
  command_failed: COMMAND_FAILED_FIXTURE,
  "agent_session:started": SESSION_FIXTURE,
  "agent_session:completed": SESSION_FIXTURE,
  "agent_session:failed": SESSION_FIXTURE,
  "agent_session:interrupted": SESSION_FIXTURE,
  "agent_session:deleted": SESSION_FIXTURE,
  "memos:captured": [
    cachedEvent({ eventType: "memos:captured", createdAt: "2026-07-04T10:00:00Z", payload: { conversationId: CONV } }),
  ],
  "agent:follow_up_scheduled": [
    cachedEvent({
      eventType: "agent:follow_up_scheduled",
      createdAt: "2026-07-04T10:00:00Z",
      payload: { followUpId: "fup_fixture", sourceConversationId: CONV },
    }),
  ],
  "delegation:created": [
    cachedEvent({
      eventType: "delegation:created",
      createdAt: "2026-07-04T10:00:00Z",
      payload: { delegationId: "dlg_fixture", title: "Fixture", sourceConversationId: CONV },
    }),
  ],
  "aside:anchored": [
    cachedEvent({
      eventType: "aside:anchored",
      createdAt: "2026-07-04T10:00:00Z",
      actorId: USER,
      payload: { asideId: "stream_aside_fixture", anchorId: "msg_1", conversationId: CONV },
    }),
  ],
}

describe("resolveBoardEventRows covers every spec-declared board row type", () => {
  it("has a fixture for exactly the BOARD_EVENT_ROW_TYPES set", () => {
    expect(new Set(Object.keys(ROW_FIXTURES))).toEqual(new Set(BOARD_EVENT_ROW_TYPES))
  })

  it("produces a row for each fixture", () => {
    const resolved: Record<string, string[]> = {}
    for (const [type, events] of Object.entries(ROW_FIXTURES)) {
      resolved[type] = resolveBoardEventRows(events, {
        conversationId: CONV,
        memberMessageIds: new Set([MEMBER_MESSAGE]),
        currentUserId: USER,
      }).map((row) => row.kind)
    }
    expect(resolved).toEqual({
      "agent_session:started": ["session"],
      "agent_session:completed": ["session"],
      "agent_session:failed": ["session"],
      "agent_session:interrupted": ["session"],
      "agent_session:deleted": ["session"],
      "memos:captured": ["memo"],
      "agent:follow_up_scheduled": ["followUp"],
      "delegation:created": ["delegation"],
      "aside:anchored": ["aside"],
      command_dispatched: ["command"],
      command_completed: ["command"],
      command_failed: ["command"],
    })
    // The object comparison above pins WHICH kind each type resolves to, but it
    // stays satisfiable by pasting the produced diff back in — a type whose
    // resolver case is missing yields `[]`, and `[]` can be written into the
    // expectation. This half names the offender and cannot be edited green.
    expect(Object.entries(resolved).filter(([, kinds]) => kinds.length === 0)).toEqual([])
  })
})

/**
 * The second wiring a new board row type needs: the Dexie rail filter. A row type
 * that ships with a companion PATCH (the `delegation:created` /
 * `delegation:status_changed` shape) gets its resolver and renderer forced by the
 * guards above, but its patch is hand-listed in `BOARD_RAIL_EVENT_TYPES` and
 * nothing above can observe it missing — both guards feed `resolveBoardEventRows`
 * a caller-supplied array, bypassing the Dexie filter entirely.
 *
 * Derivation: a patch belongs to a row type when it shares that type's `prefix:`
 * namespace (`delegation:status_changed` ↔ `delegation:created`,
 * `agent:follow_up_cancelled` ↔ `agent:follow_up_scheduled`). That is the only
 * relation the spec exposes today — `patchesRow` is a bare boolean with no
 * pointer at the row it patches — and it reproduces today's hand-list exactly.
 */
describe("BOARD_RAIL_EVENT_TYPES covers every patch belonging to a board row type", () => {
  it("subscribes to the patch types in each board row type's namespace", () => {
    const rowNamespaces = new Set(
      BOARD_EVENT_ROW_TYPES.filter((type) => type.includes(":")).map((type) => type.split(":")[0])
    )
    const requiredPatches = EVENT_TYPES.filter(
      (type) => type.includes(":") && rowNamespaces.has(type.split(":")[0]) && STREAM_ROW_SPEC[type].patchesRow
    )
    const subscribed = new Set<EventType>(BOARD_RAIL_EVENT_TYPES)
    expect(requiredPatches.filter((type) => !subscribed.has(type))).toEqual([])
  })
})

describe("resolveBoardEventRows — aside anchor rows", () => {
  const asideRow = (id: string, actorId: string, conversationId?: string) =>
    cachedEvent({
      id,
      eventType: "aside:anchored",
      createdAt: "2026-08-20T10:00:00Z",
      actorId,
      actorType: "user",
      payload: { asideId: `stream_${id}`, anchorId: "msg_1", ...(conversationId && { conversationId }) },
    })

  it("draws the creator's conversation-anchored row on that conversation only", () => {
    const events = [asideRow("mine", "usr_me", CONV), asideRow("elsewhere", "usr_me", "conv_other")]
    const rows = resolveBoardEventRows(events, {
      conversationId: CONV,
      memberMessageIds: new Set(),
      currentUserId: "usr_me",
    })
    expect(rows).toEqual([expect.objectContaining({ kind: "aside", key: "mine" })])
  })

  it("never draws another member's row, even on the matching conversation", () => {
    const events = [asideRow("theirs", "usr_other", CONV)]
    const rows = resolveBoardEventRows(events, {
      conversationId: CONV,
      memberMessageIds: new Set(),
      currentUserId: "usr_me",
    })
    expect(rows).toEqual([])
  })

  it("draws nothing for an archived aside, so a folded ledger never keeps a row the full card dropped", () => {
    const events = [asideRow("live", "usr_me", CONV), asideRow("gone", "usr_me", CONV)]
    const rows = resolveBoardEventRows(events, {
      conversationId: CONV,
      memberMessageIds: new Set(),
      currentUserId: "usr_me",
      archivedAsideIds: new Set(["stream_gone"]),
    })
    expect(rows).toEqual([expect.objectContaining({ kind: "aside", key: "live" })])
  })

  it("draws nothing for a message-anchored aside (no conversation named)", () => {
    const events = [asideRow("plain", "usr_me")]
    const rows = resolveBoardEventRows(events, {
      conversationId: CONV,
      memberMessageIds: new Set(),
      currentUserId: "usr_me",
    })
    expect(rows).toEqual([])
  })
})
