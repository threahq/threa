import { describe, it, expect } from "vitest"
import type { StreamEvent } from "@threa/types"
import {
  annotateAuthorGroups,
  filterVisibleItems,
  findFirstMessageId,
  findMessageItemIndex,
  getTimelineItemKey,
  groupTimelineItems,
  injectGapItems,
  timelineItemEqual,
  timelineRowPropsEqual,
  type TimelineItem,
  type TimelineItemRenderContext,
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

describe("injectGapItems", () => {
  function messageItem(id: string): TimelineItem {
    return {
      type: "event",
      event: createEvent({ id, sequence: "1", eventType: "message_created", payload: { messageId: `msg_${id}` } }),
    }
  }

  it("inserts a gap placeholder directly after its anchor row", () => {
    const items = [messageItem("evt_1"), messageItem("evt_2")]
    const result = injectGapItems(items, [{ afterEventId: "evt_1", missingCount: 2 }])

    expect(result).toEqual([items[0], { type: "gap", afterEventId: "evt_1", missingCount: 2 }, items[1]])
  })

  it("anchors a gap after a group that contains the anchor event", () => {
    const items: TimelineItem[] = [
      {
        type: "session_group",
        sessionId: "sess_1",
        sessionVersion: 1,
        events: [createSessionStartedEvent("evt_s1", "1", "sess_1", "msg_t")],
      },
      messageItem("evt_2"),
    ]
    const result = injectGapItems(items, [{ afterEventId: "evt_s1", missingCount: 1 }])

    expect(result[1]).toEqual({ type: "gap", afterEventId: "evt_s1", missingCount: 1 })
  })

  it("emits a placeholder for every hole anchored inside the same group", () => {
    const items: TimelineItem[] = [
      {
        type: "session_group",
        sessionId: "sess_1",
        sessionVersion: 1,
        events: [
          createSessionStartedEvent("evt_s1", "1", "sess_1", "msg_t"),
          createSessionCompletedEvent("evt_s2", "2", "sess_1"),
        ],
      },
      messageItem("evt_3"),
    ]
    const result = injectGapItems(items, [
      { afterEventId: "evt_s1", missingCount: 1 },
      { afterEventId: "evt_s2", missingCount: 2 },
    ])

    expect(result.slice(1, 3)).toEqual([
      { type: "gap", afterEventId: "evt_s1", missingCount: 1 },
      { type: "gap", afterEventId: "evt_s2", missingCount: 2 },
    ])
  })

  it("skips holes whose anchor is not in the item list and is a no-op without holes", () => {
    const items = [messageItem("evt_1")]
    expect(injectGapItems(items, [{ afterEventId: "evt_unknown", missingCount: 1 }])).toEqual(items)
    expect(injectGapItems(items, [])).toBe(items)
  })

  it("gives gap items a stable key distinct from event keys", () => {
    expect(getTimelineItemKey({ type: "gap", afterEventId: "evt_1", missingCount: 2 })).toBe("gap:evt_1")
  })

  it("keeps gap items visible through filterVisibleItems", () => {
    const items = injectGapItems([messageItem("evt_1")], [{ afterEventId: "evt_1", missingCount: 1 }])
    const visible = filterVisibleItems(items)
    expect(visible.some((item) => item.type === "gap")).toBe(true)
  })
})

describe("timelineRowPropsEqual (memoized row comparator)", () => {
  function makeCtx(overrides: Partial<TimelineItemRenderContext> = {}): TimelineItemRenderContext {
    return {
      workspaceId: "ws_1",
      streamId: "stream_123",
      sessionLiveCounts: new Map(),
      sessionLiveSubsteps: new Map(),
      sessionCanAbort: new Map(),
      ...overrides,
    }
  }

  function messageItem(event: StreamEvent): TimelineItem {
    return { type: "event", event }
  }

  const msgA = createEvent({
    id: "evt_a",
    sequence: "100",
    eventType: "message_created",
    payload: { messageId: "msg_a", contentMarkdown: "a" },
  })
  const msgB = createEvent({
    id: "evt_b",
    sequence: "200",
    eventType: "message_created",
    payload: { messageId: "msg_b", contentMarkdown: "b" },
  })

  it("equal when ctx is rebuilt with fresh containers but same per-item content", () => {
    // Simulates a data tick: new ctx object, new Set/Map identities, same content.
    const prev = {
      item: messageItem(msgA),
      ctx: makeCtx({ newMessageIds: new Set(["evt_x"]) }),
      deferSecondaryHydration: false,
    }
    const next = {
      item: { ...prev.item } as TimelineItem,
      ctx: makeCtx({ newMessageIds: new Set(["evt_x"]) }),
      deferSecondaryHydration: false,
    }
    expect(timelineRowPropsEqual(prev, next)).toBe(true)
  })

  it("not equal when the contained event identity changed (the row's own data changed)", () => {
    const patched = { ...msgA, payload: { ...(msgA.payload as object), reactions: [{ emoji: "👍" }] } }
    const prev = { item: messageItem(msgA), ctx: makeCtx(), deferSecondaryHydration: false }
    const next = { item: messageItem(patched), ctx: makeCtx(), deferSecondaryHydration: false }
    expect(timelineRowPropsEqual(prev, next)).toBe(false)
  })

  it("newMessageIds membership change invalidates only the member row", () => {
    const before = makeCtx({ newMessageIds: new Set<string>() })
    const after = makeCtx({ newMessageIds: new Set(["evt_a"]) })
    const rowA = (ctx: TimelineItemRenderContext) => ({ item: messageItem(msgA), ctx, deferSecondaryHydration: false })
    const rowB = (ctx: TimelineItemRenderContext) => ({ item: messageItem(msgB), ctx, deferSecondaryHydration: false })
    expect(timelineRowPropsEqual(rowA(before), rowA(after))).toBe(false)
    expect(timelineRowPropsEqual(rowB(before), rowB(after))).toBe(true)
  })

  it("highlight change invalidates only the highlighted row (both directions)", () => {
    const off = makeCtx()
    const on = makeCtx({ highlightMessageId: "msg_a" })
    const rowA = (ctx: TimelineItemRenderContext) => ({ item: messageItem(msgA), ctx, deferSecondaryHydration: false })
    const rowB = (ctx: TimelineItemRenderContext) => ({ item: messageItem(msgB), ctx, deferSecondaryHydration: false })
    expect(timelineRowPropsEqual(rowA(off), rowA(on))).toBe(false)
    expect(timelineRowPropsEqual(rowA(on), rowA(off))).toBe(false)
    expect(timelineRowPropsEqual(rowB(off), rowB(on))).toBe(true)
  })

  it("unread divider position change invalidates the rows gaining/losing the divider", () => {
    const before = makeCtx({ firstUnreadEventId: "evt_a" })
    const after = makeCtx({ firstUnreadEventId: "evt_b" })
    const rowA = (ctx: TimelineItemRenderContext) => ({ item: messageItem(msgA), ctx, deferSecondaryHydration: false })
    expect(timelineRowPropsEqual(rowA(before), rowA(after))).toBe(false)
  })

  it("deferSecondaryHydration flip invalidates the row", () => {
    const prev = { item: messageItem(msgA), ctx: makeCtx(), deferSecondaryHydration: true }
    const next = { item: messageItem(msgA), ctx: makeCtx(), deferSecondaryHydration: false }
    expect(timelineRowPropsEqual(prev, next)).toBe(false)
  })

  it("batch selection membership invalidates only the toggled message", () => {
    const onToggleMessage = () => {}
    const batchWith = (selected: string[]) => ({
      enabled: true,
      selectedMessageIds: new Set(selected),
      invalidTargetIds: new Set<string>(),
      hoveredTargetId: null,
      onToggleMessage,
    })
    const before = makeCtx({ batch: batchWith([]) })
    const after = makeCtx({ batch: batchWith(["msg_a"]) })
    const rowA = (ctx: TimelineItemRenderContext) => ({ item: messageItem(msgA), ctx, deferSecondaryHydration: false })
    const rowB = (ctx: TimelineItemRenderContext) => ({ item: messageItem(msgB), ctx, deferSecondaryHydration: false })
    expect(timelineRowPropsEqual(rowA(before), rowA(after))).toBe(false)
    expect(timelineRowPropsEqual(rowB(before), rowB(after))).toBe(true)
  })

  it("agent activity for the row's message invalidates it; other rows stay equal", () => {
    const activity = {
      sessionId: "sess_1",
      personaName: "Ariadne",
      stepCount: 1,
      messageCount: 0,
      substep: null,
      currentStepType: null,
    }
    const before = makeCtx({ agentActivity: new Map() })
    const after = makeCtx({ agentActivity: new Map([["msg_a", activity]]) })
    const rowA = (ctx: TimelineItemRenderContext) => ({ item: messageItem(msgA), ctx, deferSecondaryHydration: false })
    const rowB = (ctx: TimelineItemRenderContext) => ({ item: messageItem(msgB), ctx, deferSecondaryHydration: false })
    expect(timelineRowPropsEqual(rowA(before), rowA(after))).toBe(false)
    expect(timelineRowPropsEqual(rowB(before), rowB(after))).toBe(true)
  })

  it("session group: live count value change invalidates; rebuilt-but-equal maps do not", () => {
    const started = createSessionStartedEvent("evt_s", "300", "sess_1", "msg_a")
    const item: TimelineItem = { type: "session_group", sessionId: "sess_1", sessionVersion: 1, events: [started] }
    const counts = (stepCount: number) =>
      makeCtx({ sessionLiveCounts: new Map([["sess_1", { stepCount, messageCount: 0 }]]) })
    const row = (ctx: TimelineItemRenderContext) => ({ item, ctx, deferSecondaryHydration: false })
    expect(timelineRowPropsEqual(row(counts(1)), row(counts(1)))).toBe(true)
    expect(timelineRowPropsEqual(row(counts(1)), row(counts(2)))).toBe(false)
  })

  it("timelineItemEqual: rebuilt wrapper with same event identities is equal; changed groupContinuation is not", () => {
    const a: TimelineItem = { type: "event", event: msgA }
    expect(timelineItemEqual(a, { type: "event", event: msgA })).toBe(true)
    expect(timelineItemEqual(a, { type: "event", event: msgA, groupContinuation: true })).toBe(false)
    expect(timelineItemEqual(a, { type: "event", event: { ...msgA } })).toBe(false)
  })
})
