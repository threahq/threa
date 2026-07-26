import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { useUnreadDivider, isDividerReadPast } from "./use-unread-divider"
import * as useScrollToElementModule from "./use-scroll-to-element"

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(useScrollToElementModule, "useScrollToElement").mockImplementation(
    (() => undefined) as unknown as typeof useScrollToElementModule.useScrollToElement
  )
})

/** Every event renders a row of its own — the ordinary all-messages timeline. */
function anchorsOf(events: readonly { id: string }[]): Set<string> {
  return new Set(events.map((event) => event.id))
}

/** Sequence is derived from the id's numeric suffix (`event_3` → `"3"`). */
function makeMessageEvent(id: string, actorId: string, sequence = id.replace(/^\D+/, "")) {
  return {
    id,
    streamId: "stream_1",
    sequence,
    eventType: "message_created",
    payload: { messageId: `msg_${id}` },
    actorId,
    actorType: "user",
    createdAt: new Date().toISOString(),
  } as const
}

describe("useUnreadDivider", () => {
  it("does not latch a divider until the read position is resolved", () => {
    // Events are present but the viewer's read position has not hydrated yet.
    // Guessing here would latch the first message as unread and stick it for
    // the session; the divider must wait until readStateResolved flips true.
    const events = [makeMessageEvent("event_1", "other")]
    const { result, rerender } = renderHook(
      ({ readStateResolved, lastReadSequence }: { readStateResolved: boolean; lastReadSequence: bigint | null }) =>
        useUnreadDivider({
          events,
          lastReadSequence,
          currentUserId: "me",
          anchorableEventIds: anchorsOf(events),
          streamId: "stream_1",
          readStateResolved,
        }),
      { initialProps: { readStateResolved: false, lastReadSequence: null as bigint | null } }
    )

    expect(result.current.firstUnreadEventId).toBeUndefined()
    expect(result.current.dividerEventId).toBeUndefined()

    // Read position resolves and the message is already read → still no divider.
    rerender({ readStateResolved: true, lastReadSequence: 1n })
    expect(result.current.dividerEventId).toBeUndefined()
  })

  it("keeps the divider in place after the stream becomes read", () => {
    const events = [makeMessageEvent("event_1", "other"), makeMessageEvent("event_2", "other")]

    const { result, rerender } = renderHook(
      ({ lastReadSequence }: { lastReadSequence: bigint | null }) =>
        useUnreadDivider({
          events,
          lastReadSequence,
          currentUserId: "me",
          anchorableEventIds: anchorsOf(events),
          streamId: "stream_1",
          readStateResolved: true,
        }),
      {
        initialProps: { lastReadSequence: null as bigint | null },
      }
    )

    rerender({ lastReadSequence: null })
    expect(result.current.dividerEventId).toBe("event_1")

    // Auto-mark-as-read clears the live unread, but the divider stays latched
    // at its position for the rest of the reading session.
    rerender({ lastReadSequence: 2n })
    expect(result.current.firstUnreadEventId).toBeUndefined()
    expect(result.current.dividerEventId).toBe("event_1")
  })

  it("moves the divider up when an earlier message is marked unread", () => {
    const events = [
      makeMessageEvent("event_1", "other"),
      makeMessageEvent("event_2", "other"),
      makeMessageEvent("event_3", "other"),
      makeMessageEvent("event_4", "other"),
    ]
    const { result, rerender } = renderHook(
      ({ lastReadSequence }: { lastReadSequence: bigint | null }) =>
        useUnreadDivider({
          events,
          lastReadSequence,
          currentUserId: "me",
          anchorableEventIds: anchorsOf(events),
          streamId: "stream_1",
          readStateResolved: true,
        }),
      { initialProps: { lastReadSequence: 3n as bigint | null } }
    )

    // Read through event_3 → divider latched at event_4.
    expect(result.current.dividerEventId).toBe("event_4")

    // Mark event_2 unread → the read pointer moves back to event_1, so the first
    // unread is now event_2. The divider must follow it UP, not stay at event_4.
    rerender({ lastReadSequence: 1n })
    expect(result.current.dividerEventId).toBe("event_2")
  })

  it("re-shows a dismissed divider when a later mark-unread moves it to an earlier row", () => {
    const events = [
      makeMessageEvent("event_1", "other"),
      makeMessageEvent("event_2", "other"),
      makeMessageEvent("event_3", "other"),
      makeMessageEvent("event_4", "other"),
    ]
    const { result, rerender } = renderHook(
      ({ lastReadSequence }: { lastReadSequence: bigint | null }) =>
        useUnreadDivider({
          events,
          lastReadSequence,
          currentUserId: "me",
          anchorableEventIds: anchorsOf(events),
          streamId: "stream_1",
          readStateResolved: true,
        }),
      { initialProps: { lastReadSequence: 3n as bigint | null } }
    )

    expect(result.current.dividerEventId).toBe("event_4")
    act(() => result.current.dismiss())
    expect(result.current.dividerEventId).toBeUndefined()

    // Marking an earlier message unread re-positions the divider, so the prior
    // dismissal (keyed to event_4) no longer applies.
    rerender({ lastReadSequence: 1n })
    expect(result.current.dividerEventId).toBe("event_2")
  })

  it("re-latches at the new stream's first unread when switching streams", () => {
    // streamId and events (hence firstUnreadEventId) change in the same commit,
    // with no intervening undefined — the render-phase latch must re-fire here.
    const { result, rerender } = renderHook(
      ({ streamId, events }: { streamId: string; events: ReturnType<typeof makeMessageEvent>[] }) =>
        useUnreadDivider({
          events,
          lastReadSequence: null,
          currentUserId: "me",
          anchorableEventIds: anchorsOf(events),
          streamId,
          readStateResolved: true,
        }),
      { initialProps: { streamId: "stream_1", events: [makeMessageEvent("event_1", "other")] } }
    )

    expect(result.current.dividerEventId).toBe("event_1")

    rerender({ streamId: "stream_2", events: [makeMessageEvent("event_9", "other")] })
    expect(result.current.dividerEventId).toBe("event_9")
  })

  it("hides the latched divider once dismissed, and re-shows it on a fresh stream", () => {
    const { result, rerender } = renderHook(
      ({ streamId, events }: { streamId: string; events: ReturnType<typeof makeMessageEvent>[] }) =>
        useUnreadDivider({
          events,
          lastReadSequence: null,
          currentUserId: "me",
          anchorableEventIds: anchorsOf(events),
          streamId,
          readStateResolved: true,
        }),
      { initialProps: { streamId: "stream_1", events: [makeMessageEvent("event_1", "other")] } }
    )

    expect(result.current.dividerEventId).toBe("event_1")

    // Escape "escapes the unread block".
    act(() => result.current.dismiss())
    expect(result.current.dividerEventId).toBeUndefined()

    // A different stream with unread shows its divider again (dismissal is
    // scoped to the stream it happened in).
    rerender({ streamId: "stream_2", events: [makeMessageEvent("event_9", "other")] })
    expect(result.current.dividerEventId).toBe("event_9")
  })

  it("shows no divider when switching to an already-read stream", () => {
    const { result, rerender } = renderHook(
      ({
        streamId,
        events,
        lastReadSequence,
      }: {
        streamId: string
        events: ReturnType<typeof makeMessageEvent>[]
        lastReadSequence: bigint | null
      }) =>
        useUnreadDivider({
          events,
          lastReadSequence,
          currentUserId: "me",
          anchorableEventIds: anchorsOf(events),
          streamId,
          readStateResolved: true,
        }),
      {
        initialProps: {
          streamId: "stream_1",
          events: [makeMessageEvent("event_1", "other")],
          lastReadSequence: null as bigint | null,
        },
      }
    )

    expect(result.current.dividerEventId).toBe("event_1")

    rerender({
      streamId: "stream_2",
      events: [makeMessageEvent("event_9", "other")],
      lastReadSequence: 9n,
    })
    expect(result.current.dividerEventId).toBeUndefined()
  })

  it("latches off scroll-to-first-unread once a stream is deep-linked, even after the ?m= param clears", () => {
    const events = [makeMessageEvent("event_1", "other"), makeMessageEvent("event_2", "other")]
    const enabledCalls: (boolean | undefined)[] = []
    vi.spyOn(useScrollToElementModule, "useScrollToElement").mockImplementation(((
      options: { enabled?: boolean } = {}
    ) => {
      enabledCalls.push(options.enabled)
      return undefined
    }) as unknown as typeof useScrollToElementModule.useScrollToElement)

    const lastEnabled = () => enabledCalls[enabledCalls.length - 1]

    const { rerender } = renderHook(
      ({ highlightMessageId, streamId }: { highlightMessageId: string | null; streamId: string }) =>
        useUnreadDivider({
          events,
          lastReadSequence: null,
          currentUserId: "me",
          anchorableEventIds: anchorsOf(events),
          streamId,
          highlightMessageId,
          readStateResolved: true,
        }),
      { initialProps: { highlightMessageId: "msg_event_1" as string | null, streamId: "stream_1" } }
    )

    // Deep-link active: scroll-to-unread suppressed.
    expect(lastEnabled()).toBe(false)

    // ?m= auto-cleared ~3s later — must stay suppressed for this stream view.
    rerender({ highlightMessageId: null, streamId: "stream_1" })
    expect(lastEnabled()).toBe(false)

    // Switching streams resets the latch: a non-deep-linked stream scrolls normally.
    rerender({ highlightMessageId: null, streamId: "stream_2" })
    expect(lastEnabled()).toBe(true)
  })

  it("enables scroll-to-first-unread when the stream was never deep-linked", () => {
    const events = [makeMessageEvent("event_1", "other"), makeMessageEvent("event_2", "other")]
    const enabledCalls: (boolean | undefined)[] = []
    vi.spyOn(useScrollToElementModule, "useScrollToElement").mockImplementation(((
      options: { enabled?: boolean } = {}
    ) => {
      enabledCalls.push(options.enabled)
      return undefined
    }) as unknown as typeof useScrollToElementModule.useScrollToElement)

    renderHook(() =>
      useUnreadDivider({
        events,
        lastReadSequence: null,
        currentUserId: "me",
        anchorableEventIds: anchorsOf(events),
        streamId: "stream_1",
        highlightMessageId: null,
        readStateResolved: true,
      })
    )

    expect(enabledCalls[enabledCalls.length - 1]).toBe(true)
  })

  it("skips an overlay-read event and anchors the divider on the first effectively-unread row", () => {
    const events = [makeMessageEvent("event_1", "other"), makeMessageEvent("event_2", "other")]
    const { result } = renderHook(() =>
      useUnreadDivider({
        events,
        lastReadSequence: null,
        currentUserId: "me",
        anchorableEventIds: anchorsOf(events),
        streamId: "stream_1",
        readStateResolved: true,
        // event_1 was read individually above the watermark (a conversation-
        // surface read) → the divider skips it and lands on event_2.
        overlayReadIds: new Set(["msg_event_1"]),
      })
    )

    expect(result.current.dividerEventId).toBe("event_2")
  })

  it("re-latches forward at the first blurred-arrival after the session latch was consumed", () => {
    // The dogfooding bug: an earlier focused arrival consumed the session latch
    // (then auto-read greyed it). Messages arriving while the window is blurred
    // must move the divider FORWARD to the first away-arrival — as if the stream
    // had been re-opened — instead of leaving a stale grey line far above.
    const { result, rerender } = renderHook(
      ({
        events,
        lastReadSequence,
        isAttentive,
      }: {
        events: ReturnType<typeof makeMessageEvent>[]
        lastReadSequence: bigint | null
        isAttentive: boolean
      }) =>
        useUnreadDivider({
          events,
          lastReadSequence,
          currentUserId: "me",
          anchorableEventIds: anchorsOf(events),
          streamId: "stream_1",
          readStateResolved: true,
          isAttentive,
        }),
      {
        initialProps: {
          events: [makeMessageEvent("event_1", "other"), makeMessageEvent("event_2", "other")],
          lastReadSequence: null as bigint | null,
          isAttentive: true,
        },
      }
    )

    // Focused session: latch consumed at event_1, then auto-read passes it.
    expect(result.current.dividerEventId).toBe("event_1")
    rerender({
      events: [makeMessageEvent("event_1", "other"), makeMessageEvent("event_2", "other")],
      lastReadSequence: 2n,
      isAttentive: true,
    })
    expect(result.current.dividerEventId).toBe("event_1")

    // Window blurs; a message arrives while away → divider re-latches at it.
    const withBlurredArrival = [
      makeMessageEvent("event_1", "other"),
      makeMessageEvent("event_2", "other"),
      makeMessageEvent("event_3", "other"),
    ]
    rerender({ events: withBlurredArrival, lastReadSequence: 2n, isAttentive: false })
    expect(result.current.dividerEventId).toBe("event_3")

    // Refocus: the divider stays on the away block while it is still unread…
    rerender({ events: withBlurredArrival, lastReadSequence: 2n, isAttentive: true })
    expect(result.current.dividerEventId).toBe("event_3")
    expect(isDividerReadPast(withBlurredArrival, "event_3", 2n)).toBe(false)

    // …and holds position (dimming to grey) once auto-read passes it.
    rerender({ events: withBlurredArrival, lastReadSequence: 3n, isAttentive: true })
    expect(result.current.dividerEventId).toBe("event_3")
    expect(isDividerReadPast(withBlurredArrival, "event_3", 3n)).toBe(true)
  })

  it("does NOT move the divider forward while the viewer is attentive", () => {
    // Focused live arrivals get the transient flash, not a moving divider — the
    // forward re-latch is exclusively an away-time behavior.
    const { result, rerender } = renderHook(
      ({
        events,
        lastReadSequence,
      }: {
        events: ReturnType<typeof makeMessageEvent>[]
        lastReadSequence: bigint | null
      }) =>
        useUnreadDivider({
          events,
          lastReadSequence,
          currentUserId: "me",
          anchorableEventIds: anchorsOf(events),
          streamId: "stream_1",
          readStateResolved: true,
          isAttentive: true,
        }),
      {
        initialProps: {
          events: [makeMessageEvent("event_1", "other")],
          lastReadSequence: null as bigint | null,
        },
      }
    )

    expect(result.current.dividerEventId).toBe("event_1")
    rerender({ events: [makeMessageEvent("event_1", "other")], lastReadSequence: 1n })

    // A focused live arrival: first unread is now event_2, but the latch holds.
    rerender({
      events: [makeMessageEvent("event_1", "other"), makeMessageEvent("event_2", "other")],
      lastReadSequence: 1n,
    })
    expect(result.current.dividerEventId).toBe("event_1")
  })

  it("latches at the first blurred-arrival in a fully-read stream with no prior divider", () => {
    const readEvents = [makeMessageEvent("event_1", "other")]
    const { result, rerender } = renderHook(
      ({ events, isAttentive }: { events: ReturnType<typeof makeMessageEvent>[]; isAttentive: boolean }) =>
        useUnreadDivider({
          events,
          lastReadSequence: 1n,
          currentUserId: "me",
          anchorableEventIds: anchorsOf(events),
          streamId: "stream_1",
          readStateResolved: true,
          isAttentive,
        }),
      { initialProps: { events: readEvents, isAttentive: true } }
    )

    expect(result.current.dividerEventId).toBeUndefined()

    rerender({
      events: [...readEvents, makeMessageEvent("event_2", "other")],
      isAttentive: false,
    })
    expect(result.current.dividerEventId).toBe("event_2")
  })

  it("does not latch on the viewer's own message arriving while blurred", () => {
    // Sent from another device while this window is blurred — own messages are
    // never unread, so no divider.
    const readEvents = [makeMessageEvent("event_1", "other")]
    const { result, rerender } = renderHook(
      ({ events, isAttentive }: { events: ReturnType<typeof makeMessageEvent>[]; isAttentive: boolean }) =>
        useUnreadDivider({
          events,
          lastReadSequence: 1n,
          currentUserId: "me",
          anchorableEventIds: anchorsOf(events),
          streamId: "stream_1",
          readStateResolved: true,
          isAttentive,
        }),
      { initialProps: { events: readEvents, isAttentive: true } }
    )

    rerender({ events: [...readEvents, makeMessageEvent("event_2", "me")], isAttentive: false })
    expect(result.current.dividerEventId).toBeUndefined()
  })

  it("re-shows a dismissed divider when a blur re-latch moves it to the away block", () => {
    // Dismissal is keyed to the latched position; new messages while away are a
    // fresh unread block the viewer has not escaped.
    const { result, rerender } = renderHook(
      ({
        events,
        lastReadSequence,
        isAttentive,
      }: {
        events: ReturnType<typeof makeMessageEvent>[]
        lastReadSequence: bigint | null
        isAttentive: boolean
      }) =>
        useUnreadDivider({
          events,
          lastReadSequence,
          currentUserId: "me",
          anchorableEventIds: anchorsOf(events),
          streamId: "stream_1",
          readStateResolved: true,
          isAttentive,
        }),
      {
        initialProps: {
          events: [makeMessageEvent("event_1", "other")],
          lastReadSequence: null as bigint | null,
          isAttentive: true,
        },
      }
    )

    expect(result.current.dividerEventId).toBe("event_1")
    act(() => result.current.dismiss())
    expect(result.current.dividerEventId).toBeUndefined()

    rerender({
      events: [makeMessageEvent("event_1", "other"), makeMessageEvent("event_2", "other")],
      lastReadSequence: 1n,
      isAttentive: false,
    })
    expect(result.current.dividerEventId).toBe("event_2")
  })

  it("skips an unread event that renders no row and anchors on the next one that does", () => {
    // A first unread the timeline drops (a zero-height event type, another
    // user's command events, a session card hidden in a channel) used to latch
    // the divider on a row that does not exist: no "New" line rendered and both
    // scroll paths resolved no index, so open-at-marker silently no-opped.
    const events = [
      { ...makeMessageEvent("event_1", "other"), eventType: "command_dispatched" as const },
      makeMessageEvent("event_2", "other"),
    ]
    const { result } = renderHook(() =>
      useUnreadDivider({
        events,
        lastReadSequence: null,
        currentUserId: "me",
        anchorableEventIds: new Set(["event_2"]),
        streamId: "stream_1",
        readStateResolved: true,
      })
    )

    expect(result.current.dividerEventId).toBe("event_2")
  })

  it("shows no divider when no unread event renders a row", () => {
    const events = [{ ...makeMessageEvent("event_1", "other"), eventType: "reaction_added" as const }]
    const { result } = renderHook(() =>
      useUnreadDivider({
        events,
        lastReadSequence: null,
        currentUserId: "me",
        anchorableEventIds: new Set<string>(),
        streamId: "stream_1",
        readStateResolved: true,
      })
    )

    expect(result.current.dividerEventId).toBeUndefined()
  })

  it("shows no divider when every candidate unread row is overlay-read", () => {
    const events = [makeMessageEvent("event_1", "other"), makeMessageEvent("event_2", "other")]
    const { result } = renderHook(() =>
      useUnreadDivider({
        events,
        lastReadSequence: null,
        currentUserId: "me",
        anchorableEventIds: anchorsOf(events),
        streamId: "stream_1",
        readStateResolved: true,
        overlayReadIds: new Set(["msg_event_1", "msg_event_2"]),
      })
    )

    expect(result.current.dividerEventId).toBeUndefined()
  })

  it("anchors the divider when the frontier sits far below the loaded window", () => {
    // THE DEFECT: the watermark event (sequence 5) is nowhere in the tail-anchored
    // window, so the old position lookup returned undefined and no line rendered.
    const events = [makeMessageEvent("event_a", "other", "100"), makeMessageEvent("event_b", "other", "150")]
    const { result } = renderHook(() =>
      useUnreadDivider({
        events,
        lastReadSequence: 5n,
        currentUserId: "me",
        anchorableEventIds: anchorsOf(events),
        streamId: "stream_1",
        readStateResolved: true,
      })
    )

    expect(result.current.dividerEventId).toBe("event_a")
  })

  it("places the divider on the first event past a frontier whose own event is not loaded", () => {
    const events = [
      makeMessageEvent("event_a", "other", "100"),
      makeMessageEvent("event_b", "other", "130"),
      makeMessageEvent("event_c", "other", "150"),
    ]
    const { result } = renderHook(() =>
      useUnreadDivider({
        events,
        lastReadSequence: 120n,
        currentUserId: "me",
        anchorableEventIds: anchorsOf(events),
        streamId: "stream_1",
        readStateResolved: true,
      })
    )

    expect(result.current.dividerEventId).toBe("event_b")
  })

  it("treats a null frontier as never-read and anchors on the first loaded row", () => {
    const events = [makeMessageEvent("event_a", "other", "100"), makeMessageEvent("event_b", "other", "150")]
    const { result } = renderHook(() =>
      useUnreadDivider({
        events,
        lastReadSequence: null,
        currentUserId: "me",
        anchorableEventIds: anchorsOf(events),
        streamId: "stream_1",
        readStateResolved: true,
      })
    )

    expect(result.current.dividerEventId).toBe("event_a")
  })

  it("never latches or scrolls while the frontier is unresolved", () => {
    // The input that makes resolveUnreadMarkerOpen return "wait": no divider and
    // no scroll, so the once-per-stream marker decision stays unconsumed.
    const events = [makeMessageEvent("event_1", "other")]
    const enabledCalls: (boolean | undefined)[] = []
    vi.spyOn(useScrollToElementModule, "useScrollToElement").mockImplementation(((
      options: { enabled?: boolean } = {}
    ) => {
      enabledCalls.push(options.enabled)
      return undefined
    }) as unknown as typeof useScrollToElementModule.useScrollToElement)

    const { result } = renderHook(() =>
      useUnreadDivider({
        events,
        lastReadSequence: null,
        currentUserId: "me",
        anchorableEventIds: anchorsOf(events),
        streamId: "stream_1",
        readStateResolved: false,
      })
    )

    expect(result.current.dividerEventId).toBeUndefined()
    expect(enabledCalls[enabledCalls.length - 1]).toBe(false)
  })

  it("does not anchor on the viewer's own pending event with a placeholder sequence", () => {
    // Optimistic sends carry a Date.now()-scale sequence far above the window
    // (lib/optimistic-sequence.ts) — own rows are never unread regardless.
    const events = [
      makeMessageEvent("event_a", "other", "100"),
      makeMessageEvent("event_pending", "me", String(Date.now())),
    ]
    const { result } = renderHook(() =>
      useUnreadDivider({
        events,
        lastReadSequence: 100n,
        currentUserId: "me",
        anchorableEventIds: anchorsOf(events),
        streamId: "stream_1",
        readStateResolved: true,
      })
    )

    expect(result.current.dividerEventId).toBeUndefined()
  })
})

describe("isDividerReadPast", () => {
  // Sequences are numeric bigint strings (compared via BigInt), unlike the id.
  const events = [
    { id: "event_1", sequence: "1" },
    { id: "event_2", sequence: "2" },
    { id: "event_3", sequence: "3" },
  ] as unknown as Parameters<typeof isDividerReadPast>[0]

  it("is red (not read past) while the read pointer sits before the divider", () => {
    // Divider at event_2, pointer at event_1 (unread still at/after the line).
    expect(isDividerReadPast(events, "event_2", 1n)).toBe(false)
  })

  it("is grey (read past) once the pointer reaches or passes the divider", () => {
    expect(isDividerReadPast(events, "event_2", 2n)).toBe(true)
    expect(isDividerReadPast(events, "event_2", 3n)).toBe(true)
  })

  it("is grey when the frontier is past the divider but the watermark event is not loaded", () => {
    // The second half of the defect: an out-of-window watermark used to pin the
    // line red forever, since the pointer row could not be found in `events`.
    expect(isDividerReadPast(events, "event_2", 999n)).toBe(true)
  })

  it("is red when nothing is read yet (null pointer) or the divider is hidden", () => {
    expect(isDividerReadPast(events, "event_2", null)).toBe(false)
    expect(isDividerReadPast(events, undefined, 3n)).toBe(false)
  })
})
