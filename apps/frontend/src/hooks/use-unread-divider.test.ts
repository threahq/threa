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
  it("clears the displayed divider when the stream becomes read after mount", async () => {
    const events = [makeMessageEvent("event_1", "other"), makeMessageEvent("event_2", "other")]

    const { result, rerender } = renderHook(
      ({ lastReadEventId }: { lastReadEventId: string | null | undefined }) =>
        useUnreadDivider({
          events,
          lastReadEventId,
          currentUserId: "me",
          streamId: "stream_1",
        }),
      {
        initialProps: { lastReadEventId: null as string | null | undefined },
      }
    )

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    rerender({ lastReadEventId: null })
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.dividerEventId).toBe("event_1")

    rerender({ lastReadEventId: "event_2" })

    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.firstUnreadEventId).toBeUndefined()
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
          lastReadEventId: null,
          currentUserId: "me",
          streamId,
          highlightMessageId,
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
      })
    )

    expect(enabledCalls[enabledCalls.length - 1]).toBe(true)
  })
})
