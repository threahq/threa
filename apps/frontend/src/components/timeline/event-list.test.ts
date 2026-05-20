import { describe, it, expect } from "vitest"
import type { StreamEvent } from "@threa/types"
import {
  annotateAuthorGroups,
  findFirstMessageId,
  findMessageItemIndex,
  groupTimelineItems,
  type TimelineItem,
} from "./event-list"

interface CreateEventParams {
  id: string
  sequence: string
  eventType: StreamEvent["eventType"]
  payload: unknown
}

function createEvent(params: CreateEventParams): StreamEvent {
  return {
    id: params.id,
    streamId: "stream_123",
    sequence: params.sequence,
    eventType: params.eventType,
    payload: params.payload,
    actorId: "persona_system_ariadne",
    actorType: "persona",
    createdAt: "2026-02-19T00:00:00.000Z",
  }
}

function createSessionStartedEvent(
  id: string,
  sequence: string,
  sessionId: string,
  triggerMessageId: string
): StreamEvent {
  return createEvent({
    id,
    sequence,
    eventType: "agent_session:started",
    payload: {
      sessionId,
      personaId: "persona_system_ariadne",
      personaName: "Ariadne",
      triggerMessageId,
      startedAt: "2026-02-19T00:00:00.000Z",
    },
  })
}

function createSessionCompletedEvent(id: string, sequence: string, sessionId: string): StreamEvent {
  return createEvent({
    id,
    sequence,
    eventType: "agent_session:completed",
    payload: {
      sessionId,
      stepCount: 1,
      messageCount: 1,
      duration: 1000,
      completedAt: "2026-02-19T00:00:01.000Z",
    },
  })
}

function createSessionFailedEvent(id: string, sequence: string, sessionId: string): StreamEvent {
  return createEvent({
    id,
    sequence,
    eventType: "agent_session:failed",
    payload: {
      sessionId,
      stepCount: 1,
      error: "failed",
      traceId: sessionId,
      failedAt: "2026-02-19T00:00:02.000Z",
    },
  })
}

describe("groupTimelineItems", () => {
  it("replaces the previous session card when a superseding session starts", () => {
    const events: StreamEvent[] = [
      createSessionStartedEvent("event_s1_started", "1", "session_1", "msg_1"),
      createSessionCompletedEvent("event_s1_completed", "2", "session_1"),
      createSessionStartedEvent("event_s2_started", "3", "session_2", "msg_1"),
      createSessionCompletedEvent("event_s2_completed", "4", "session_2"),
      createSessionFailedEvent("event_s1_failed_late", "5", "session_1"),
    ]

    const items = groupTimelineItems(events, "member_123")
    const sessionGroups = items.filter((item) => item.type === "session_group")

    expect(sessionGroups).toHaveLength(1)
    expect(sessionGroups[0]!.sessionId).toBe("session_2")
    expect(sessionGroups[0]!.sessionVersion).toBe(2)
    expect(sessionGroups[0]!.events.map((event) => event.id)).toEqual(["event_s2_started", "event_s2_completed"])
  })

  it("keeps separate cards for sessions with different trigger messages", () => {
    const events: StreamEvent[] = [
      createSessionStartedEvent("event_s1_started", "1", "session_1", "msg_1"),
      createSessionCompletedEvent("event_s1_completed", "2", "session_1"),
      createSessionStartedEvent("event_s2_started", "3", "session_2", "msg_2"),
      createSessionCompletedEvent("event_s2_completed", "4", "session_2"),
    ]

    const items = groupTimelineItems(events, "member_123")
    const sessionGroups = items.filter((item) => item.type === "session_group")

    expect(sessionGroups).toHaveLength(2)
    expect(sessionGroups.map((group) => group.sessionId)).toEqual(["session_1", "session_2"])
    expect(sessionGroups.map((group) => group.sessionVersion)).toEqual([1, 1])
  })

  it("keeps completed/failed session events in one card when started arrives later in the window", () => {
    const events: StreamEvent[] = [
      createSessionCompletedEvent("event_s1_completed", "2", "session_1"),
      createSessionStartedEvent("event_s1_started_late", "3", "session_1", "msg_1"),
      createSessionFailedEvent("event_s1_failed", "4", "session_1"),
    ]

    const items = groupTimelineItems(events, "member_123")
    const sessionGroups = items.filter((item) => item.type === "session_group")

    expect(sessionGroups).toHaveLength(1)
    expect(sessionGroups[0]!.sessionId).toBe("session_1")
    expect(sessionGroups[0]!.events.map((event) => event.id)).toEqual([
      "event_s1_completed",
      "event_s1_started_late",
      "event_s1_failed",
    ])
  })
})

interface CreateMessageEventParams {
  id: string
  actorId: string
  actorType?: StreamEvent["actorType"]
  createdAt: string
  eventType?: StreamEvent["eventType"]
  payload?: Record<string, unknown>
}

function createMessageEvent(params: CreateMessageEventParams): StreamEvent {
  return {
    id: params.id,
    streamId: "stream_123",
    sequence: params.id,
    eventType: params.eventType ?? "message_created",
    payload: { messageId: `msg_${params.id}`, contentMarkdown: "hi", ...params.payload },
    actorId: params.actorId,
    actorType: params.actorType ?? "user",
    createdAt: params.createdAt,
  }
}

function toEventItem(event: StreamEvent): TimelineItem {
  return { type: "event", event }
}

function continuationFlags(items: TimelineItem[]): boolean[] {
  return items.map((item) => (item.type === "event" ? !!item.groupContinuation : false))
}

describe("annotateAuthorGroups", () => {
  it("marks consecutive same-author messages within 5 minutes as continuations", () => {
    const items = [
      toEventItem(createMessageEvent({ id: "1", actorId: "user_a", createdAt: "2026-04-19T10:00:00Z" })),
      toEventItem(createMessageEvent({ id: "2", actorId: "user_a", createdAt: "2026-04-19T10:01:00Z" })),
      toEventItem(createMessageEvent({ id: "3", actorId: "user_a", createdAt: "2026-04-19T10:04:59Z" })),
      toEventItem(createMessageEvent({ id: "4", actorId: "user_a", createdAt: "2026-04-19T10:05:00Z" })),
    ]

    // First is always a head; rest are continuations (each within 5min of the one before it).
    expect(continuationFlags(annotateAuthorGroups(items))).toEqual([false, true, true, true])
  })

  it("breaks the run when the author changes", () => {
    const items = [
      toEventItem(createMessageEvent({ id: "1", actorId: "user_a", createdAt: "2026-04-19T10:00:00Z" })),
      toEventItem(createMessageEvent({ id: "2", actorId: "user_b", createdAt: "2026-04-19T10:00:30Z" })),
      toEventItem(createMessageEvent({ id: "3", actorId: "user_a", createdAt: "2026-04-19T10:01:00Z" })),
    ]

    expect(continuationFlags(annotateAuthorGroups(items))).toEqual([false, false, false])
  })

  it("breaks the run when the actorType changes (user → persona)", () => {
    const items = [
      toEventItem(createMessageEvent({ id: "1", actorId: "actor_1", createdAt: "2026-04-19T10:00:00Z" })),
      toEventItem(
        createMessageEvent({
          id: "2",
          actorId: "actor_1",
          actorType: "persona",
          createdAt: "2026-04-19T10:00:30Z",
        })
      ),
    ]

    expect(continuationFlags(annotateAuthorGroups(items))).toEqual([false, false])
  })

  it("breaks the run once messages are more than 5 minutes apart", () => {
    const items = [
      toEventItem(createMessageEvent({ id: "1", actorId: "user_a", createdAt: "2026-04-19T10:00:00Z" })),
      toEventItem(createMessageEvent({ id: "2", actorId: "user_a", createdAt: "2026-04-19T10:05:01Z" })),
    ]

    expect(continuationFlags(annotateAuthorGroups(items))).toEqual([false, false])
  })

  it("treats deleted messages as heads and resets the run for the next message", () => {
    const items = [
      toEventItem(createMessageEvent({ id: "1", actorId: "user_a", createdAt: "2026-04-19T10:00:00Z" })),
      toEventItem(
        createMessageEvent({
          id: "2",
          actorId: "user_a",
          createdAt: "2026-04-19T10:00:30Z",
          payload: { deletedAt: "2026-04-19T10:02:00Z" },
        })
      ),
      toEventItem(createMessageEvent({ id: "3", actorId: "user_a", createdAt: "2026-04-19T10:01:00Z" })),
    ]

    expect(continuationFlags(annotateAuthorGroups(items))).toEqual([false, false, false])
  })

  it("breaks the run when a non-message event (command/session group) appears mid-run", () => {
    const messageEvent = toEventItem(
      createMessageEvent({ id: "1", actorId: "user_a", createdAt: "2026-04-19T10:00:00Z" })
    )
    const commandGroup: TimelineItem = {
      type: "command_group",
      commandId: "cmd_1",
      events: [],
    }
    const nextMessage = toEventItem(
      createMessageEvent({ id: "2", actorId: "user_a", createdAt: "2026-04-19T10:00:30Z" })
    )

    expect(continuationFlags(annotateAuthorGroups([messageEvent, commandGroup, nextMessage]))).toEqual([
      false,
      false,
      false,
    ])
  })

  it("treats companion_response as a groupable message type", () => {
    const items = [
      toEventItem(
        createMessageEvent({
          id: "1",
          actorId: "persona_ariadne",
          actorType: "persona",
          eventType: "companion_response",
          createdAt: "2026-04-19T10:00:00Z",
        })
      ),
      toEventItem(
        createMessageEvent({
          id: "2",
          actorId: "persona_ariadne",
          actorType: "persona",
          eventType: "companion_response",
          createdAt: "2026-04-19T10:00:30Z",
        })
      ),
    ]

    expect(continuationFlags(annotateAuthorGroups(items))).toEqual([false, true])
  })

  it("leaves non-message events untouched so command/session groups render normally", () => {
    const input: TimelineItem[] = [
      { type: "command_group", commandId: "cmd_1", events: [] },
      { type: "session_group", sessionId: "sess_1", sessionVersion: 1, events: [] },
    ]
    expect(annotateAuthorGroups(input)).toEqual(input)
  })
})

describe("findFirstMessageId", () => {
  function eventItem(
    id: string,
    sequence: string,
    eventType: StreamEvent["eventType"],
    messageId: string
  ): TimelineItem {
    return {
      type: "event",
      event: createEvent({ id, sequence, eventType, payload: { messageId } }),
    }
  }

  it("returns the messageId of the first message_created event in render order", () => {
    const items: TimelineItem[] = [
      eventItem("evt_1", "1", "message_created", "msg_first"),
      eventItem("evt_2", "2", "message_created", "msg_second"),
    ]
    expect(findFirstMessageId(items)).toBe("msg_first")
  })

  it("ignores companion_response events so the badge can't anchor on Ariadne's reply", () => {
    // Restricted to user-authored messages on purpose: in a bag-attached
    // scratchpad the conversation always opens with the user's question.
    // Hide rather than mis-anchor when an offline-reconnect ordering glitch
    // (or some agent edge case) puts a companion_response first.
    const items: TimelineItem[] = [
      eventItem("evt_1", "1", "companion_response", "msg_companion"),
      eventItem("evt_2", "2", "message_created", "msg_user"),
    ]
    expect(findFirstMessageId(items)).toBe("msg_user")
  })

  it("returns undefined when only companion_response events exist (no user message yet)", () => {
    const items: TimelineItem[] = [eventItem("evt_1", "1", "companion_response", "msg_companion")]
    expect(findFirstMessageId(items)).toBeUndefined()
  })

  it("skips command_group / session_group items and finds the first underlying message", () => {
    const items: TimelineItem[] = [
      { type: "command_group", commandId: "cmd_1", events: [] },
      { type: "session_group", sessionId: "sess_1", sessionVersion: 1, events: [] },
      eventItem("evt_1", "3", "message_created", "msg_after_groups"),
    ]
    expect(findFirstMessageId(items)).toBe("msg_after_groups")
  })

  it("ignores events without a messageId payload (membership events, etc.)", () => {
    const items: TimelineItem[] = [
      { type: "event", event: createEvent({ id: "evt_1", sequence: "1", eventType: "member_joined", payload: {} }) },
      eventItem("evt_2", "2", "message_created", "msg_real"),
    ]
    expect(findFirstMessageId(items)).toBe("msg_real")
  })

  it("returns undefined for an empty timeline so the badge stays in the composer strip", () => {
    expect(findFirstMessageId([])).toBeUndefined()
  })
})

describe("findMessageItemIndex", () => {
  function eventItem(id: string, messageId: string): TimelineItem {
    return {
      type: "event",
      event: createEvent({ id, sequence: id, eventType: "message_created", payload: { messageId } }),
    }
  }

  it("returns the index of the timeline item rendering the message", () => {
    const items: TimelineItem[] = [
      eventItem("evt_1", "msg_a"),
      eventItem("evt_2", "msg_b"),
      eventItem("evt_3", "msg_c"),
    ]
    expect(findMessageItemIndex(items, "msg_b")).toBe(1)
  })

  it("returns -1 when the message is not in the window (so callers never feed Virtuoso a stale index)", () => {
    // The crash this guards: scrollToIndex with an out-of-range index drives
    // react-virtuoso's offset-tree binary search to an undefined node.
    const items: TimelineItem[] = [eventItem("evt_1", "msg_a")]
    expect(findMessageItemIndex(items, "msg_gone")).toBe(-1)
  })

  it("returns -1 for an empty timeline (mid jump-window swap)", () => {
    expect(findMessageItemIndex([], "msg_a")).toBe(-1)
  })

  it("skips command_group / session_group items when locating the message", () => {
    const items: TimelineItem[] = [
      { type: "command_group", commandId: "cmd_1", events: [] },
      { type: "session_group", sessionId: "sess_1", sessionVersion: 1, events: [] },
      eventItem("evt_1", "msg_target"),
    ]
    expect(findMessageItemIndex(items, "msg_target")).toBe(2)
  })

  it("ignores events without a messageId payload", () => {
    const items: TimelineItem[] = [
      { type: "event", event: createEvent({ id: "evt_1", sequence: "1", eventType: "member_joined", payload: {} }) },
      eventItem("evt_2", "msg_real"),
    ]
    expect(findMessageItemIndex(items, "msg_real")).toBe(1)
  })
})
