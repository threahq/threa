import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useNewMessageIndicator } from "./use-new-message-indicator"
import type { StreamEvent } from "@threahq/types"

function makeEvent(overrides: Partial<StreamEvent> & { id: string; sequence: string }): StreamEvent {
  return {
    eventType: "message_created",
    actorId: "other_user",
    actorType: "user",
    streamId: "stream_1",
    payload: {},
    createdAt: "2026-04-01T00:00:00Z",
    ...overrides,
  } as StreamEvent
}

const currentUserId = "current_user"
const streamId = "stream_1"

describe("useNewMessageIndicator", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("does not flash events present on first render", () => {
    const events = [makeEvent({ id: "evt_1", sequence: "1" }), makeEvent({ id: "evt_5", sequence: "5" })]

    const { result } = renderHook(() => useNewMessageIndicator(events, currentUserId, streamId, "evt_5"))

    expect(result.current.size).toBe(0)
  })

  it("flashes socket events that arrive after the initial snapshot", () => {
    const events = [makeEvent({ id: "evt_1", sequence: "1" }), makeEvent({ id: "evt_5", sequence: "5" })]

    const { result, rerender } = renderHook(
      ({ events: evts, lastRead }) => useNewMessageIndicator(evts, currentUserId, streamId, lastRead),
      { initialProps: { events, lastRead: "evt_5" as string | null } }
    )

    expect(result.current.size).toBe(0)

    const withSocket = [...events, makeEvent({ id: "evt_6", sequence: "6" })]
    rerender({ events: withSocket, lastRead: "evt_5" })

    expect(result.current.has("evt_6")).toBe(true)
  })

  it("does not flash events from the current user", () => {
    const events = [makeEvent({ id: "evt_1", sequence: "1" })]

    const { result, rerender } = renderHook(
      ({ events: evts }) => useNewMessageIndicator(evts, currentUserId, streamId, "evt_1"),
      { initialProps: { events } }
    )

    const updated = [...events, makeEvent({ id: "evt_2", sequence: "2", actorId: currentUserId })]
    rerender({ events: updated })

    expect(result.current.size).toBe(0)
  })

  it("does not flash events at or before lastReadEventId", () => {
    const events = [makeEvent({ id: "evt_1", sequence: "1" }), makeEvent({ id: "evt_5", sequence: "5" })]

    const { result, rerender } = renderHook(
      ({ events: evts, lastRead }) => useNewMessageIndicator(evts, currentUserId, streamId, lastRead),
      { initialProps: { events, lastRead: "evt_5" as string | null } }
    )

    expect(result.current.size).toBe(0)

    rerender({ events: [...events], lastRead: "evt_5" })
    expect(result.current.size).toBe(0)
  })

  it("does not flash already-present unread events (divider handles those)", () => {
    const events = [
      makeEvent({ id: "evt_1", sequence: "1" }),
      makeEvent({ id: "evt_5", sequence: "5" }),
      makeEvent({ id: "evt_8", sequence: "8" }),
      makeEvent({ id: "evt_10", sequence: "10" }),
    ]

    const { result } = renderHook(() => useNewMessageIndicator(events, currentUserId, streamId, "evt_5"))

    expect(result.current.size).toBe(0)
  })

  it("does not flash events already present when switching streams", () => {
    const streamAEvents = [makeEvent({ id: "evt_a1", sequence: "10" })]

    const { result, rerender } = renderHook(
      ({ events, sid, lastRead }) => useNewMessageIndicator(events, currentUserId, sid, lastRead),
      { initialProps: { events: streamAEvents, sid: "stream_a", lastRead: "evt_a1" as string | null } }
    )

    expect(result.current.size).toBe(0)

    const streamBEvents = [makeEvent({ id: "evt_b1", sequence: "50" }), makeEvent({ id: "evt_b2", sequence: "60" })]
    rerender({ events: streamBEvents, sid: "stream_b", lastRead: "evt_b2" })

    expect(result.current.size).toBe(0)
  })

  it("does not re-flash on back-and-forth navigation", () => {
    const events = [makeEvent({ id: "evt_1", sequence: "1" }), makeEvent({ id: "evt_5", sequence: "5" })]

    const { result, rerender } = renderHook(
      ({ events, sid, lastRead }) => useNewMessageIndicator(events, currentUserId, sid, lastRead),
      { initialProps: { events, sid: streamId, lastRead: "evt_5" as string | null } }
    )

    expect(result.current.size).toBe(0)

    rerender({ events: [], sid: "stream_2", lastRead: null })
    expect(result.current.size).toBe(0)

    rerender({ events, sid: streamId, lastRead: "evt_5" })
    expect(result.current.size).toBe(0)
  })

  it("does not flash events that arrive while the viewer is away, even after refocus", () => {
    // Away-arrivals get the persistent unread divider (blur re-latch) instead;
    // flashing them too would double-signal the same rows on refocus.
    const initial = [makeEvent({ id: "evt_1", sequence: "1" })]

    const { result, rerender } = renderHook(
      ({ events, isAttentive }: { events: StreamEvent[]; isAttentive: boolean }) =>
        useNewMessageIndicator(events, currentUserId, streamId, "evt_1", undefined, isAttentive),
      { initialProps: { events: initial, isAttentive: true } }
    )

    const withAwayArrival = [...initial, makeEvent({ id: "evt_2", sequence: "2" })]
    rerender({ events: withAwayArrival, isAttentive: false })
    expect(result.current.size).toBe(0)

    // Refocus: the away-arrival is already known — it must not flash late.
    rerender({ events: withAwayArrival, isAttentive: true })
    expect(result.current.size).toBe(0)
  })

  it("flashes events arriving after refocus as usual", () => {
    const initial = [makeEvent({ id: "evt_1", sequence: "1" })]

    const { result, rerender } = renderHook(
      ({ events, isAttentive }: { events: StreamEvent[]; isAttentive: boolean }) =>
        useNewMessageIndicator(events, currentUserId, streamId, "evt_1", undefined, isAttentive),
      { initialProps: { events: initial, isAttentive: true } }
    )

    const withAwayArrival = [...initial, makeEvent({ id: "evt_2", sequence: "2" })]
    rerender({ events: withAwayArrival, isAttentive: false })

    const withFocusedArrival = [...withAwayArrival, makeEvent({ id: "evt_3", sequence: "3" })]
    rerender({ events: withFocusedArrival, isAttentive: true })

    expect(result.current.has("evt_3")).toBe(true)
    expect(result.current.has("evt_2")).toBe(false)
  })

  it("expires flashed IDs after 2 seconds", () => {
    const initial = [makeEvent({ id: "evt_1", sequence: "1" })]

    const { result, rerender } = renderHook(
      ({ events }) => useNewMessageIndicator(events, currentUserId, streamId, "evt_1"),
      { initialProps: { events: initial } }
    )

    const updated = [...initial, makeEvent({ id: "evt_2", sequence: "2" })]
    rerender({ events: updated })
    expect(result.current.has("evt_2")).toBe(true)

    act(() => {
      vi.advanceTimersByTime(2000)
    })

    expect(result.current.size).toBe(0)
  })
})
