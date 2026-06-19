import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { useUnreadDivider } from "./use-unread-divider"
import * as useScrollToElementModule from "./use-scroll-to-element"

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(useScrollToElementModule, "useScrollToElement").mockImplementation(
    (() => undefined) as unknown as typeof useScrollToElementModule.useScrollToElement
  )
})

function makeMessageEvent(id: string, actorId: string) {
  return {
    id,
    streamId: "stream_1",
    sequence: id,
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
      ({ readStateResolved, lastReadEventId }: { readStateResolved: boolean; lastReadEventId: string | null }) =>
        useUnreadDivider({
          events,
          lastReadEventId,
          currentUserId: "me",
          streamId: "stream_1",
          readStateResolved,
        }),
      { initialProps: { readStateResolved: false, lastReadEventId: null as string | null } }
    )

    expect(result.current.firstUnreadEventId).toBeUndefined()
    expect(result.current.dividerEventId).toBeUndefined()

    // Read position resolves and the message is already read → still no divider.
    rerender({ readStateResolved: true, lastReadEventId: "event_1" })
    expect(result.current.dividerEventId).toBeUndefined()
  })

  it("keeps the divider in place after the stream becomes read, then dims it", async () => {
    vi.useFakeTimers()
    try {
      const events = [makeMessageEvent("event_1", "other"), makeMessageEvent("event_2", "other")]

      const { result, rerender } = renderHook(
        ({ lastReadEventId }: { lastReadEventId: string | null | undefined }) =>
          useUnreadDivider({
            events,
            lastReadEventId,
            currentUserId: "me",
            streamId: "stream_1",
            readStateResolved: true,
          }),
        {
          initialProps: { lastReadEventId: null as string | null | undefined },
        }
      )

      rerender({ lastReadEventId: null })
      expect(result.current.dividerEventId).toBe("event_1")
      expect(result.current.isDimmed).toBe(false)

      // Auto-mark-as-read clears the live unread, but the divider stays latched
      // at its position for the rest of the reading session.
      rerender({ lastReadEventId: "event_2" })
      expect(result.current.firstUnreadEventId).toBeUndefined()
      expect(result.current.dividerEventId).toBe("event_1")
      expect(result.current.isDimmed).toBe(false)

      // After the dim delay it settles to gray but remains present.
      act(() => {
        vi.advanceTimersByTime(3000)
      })
      expect(result.current.dividerEventId).toBe("event_1")
      expect(result.current.isDimmed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("re-latches at the new stream's first unread when switching streams", () => {
    // streamId and events (hence firstUnreadEventId) change in the same commit,
    // with no intervening undefined — the render-phase latch must re-fire here.
    const { result, rerender } = renderHook(
      ({ streamId, events }: { streamId: string; events: ReturnType<typeof makeMessageEvent>[] }) =>
        useUnreadDivider({
          events,
          lastReadEventId: null,
          currentUserId: "me",
          streamId,
          readStateResolved: true,
        }),
      { initialProps: { streamId: "stream_1", events: [makeMessageEvent("event_1", "other")] } }
    )

    expect(result.current.dividerEventId).toBe("event_1")

    rerender({ streamId: "stream_2", events: [makeMessageEvent("event_9", "other")] })
    expect(result.current.dividerEventId).toBe("event_9")
  })

  it("shows no divider when switching to an already-read stream", () => {
    const { result, rerender } = renderHook(
      ({
        streamId,
        events,
        lastReadEventId,
      }: {
        streamId: string
        events: ReturnType<typeof makeMessageEvent>[]
        lastReadEventId: string | null
      }) => useUnreadDivider({ events, lastReadEventId, currentUserId: "me", streamId, readStateResolved: true }),
      {
        initialProps: {
          streamId: "stream_1",
          events: [makeMessageEvent("event_1", "other")],
          lastReadEventId: null as string | null,
        },
      }
    )

    expect(result.current.dividerEventId).toBe("event_1")

    rerender({
      streamId: "stream_2",
      events: [makeMessageEvent("event_9", "other")],
      lastReadEventId: "event_9",
    })
    expect(result.current.dividerEventId).toBeUndefined()
    expect(result.current.isDimmed).toBe(false)
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
          lastReadEventId: null,
          currentUserId: "me",
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
        lastReadEventId: null,
        currentUserId: "me",
        streamId: "stream_1",
        highlightMessageId: null,
        readStateResolved: true,
      })
    )

    expect(enabledCalls[enabledCalls.length - 1]).toBe(true)
  })
})
