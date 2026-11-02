import { describe, it, expect, beforeEach, vi } from "vitest"
import { _testing } from "./use-link-preview-dismissals"

type Handler = (payload: { messageId: string; linkPreviewId: string }) => void

function createMockSocket() {
  const listeners = new Map<string, Set<Handler>>()
  return {
    on: vi.fn((event: string, handler: Handler) => {
      let set = listeners.get(event)
      if (!set) {
        set = new Set()
        listeners.set(event, set)
      }
      set.add(handler)
    }),
    off: vi.fn((event: string, handler: Handler) => {
      listeners.get(event)?.delete(handler)
    }),
    /** Simulate the server emitting an event */
    emit(event: string, payload: unknown) {
      for (const handler of listeners.get(event) ?? []) {
        handler(payload as { messageId: string; linkPreviewId: string })
      }
    },
    listenerCount(event: string) {
      return listeners.get(event)?.size ?? 0
    },
  }
}

describe("link preview dismissal fan-out", () => {
  beforeEach(() => {
    _testing.reset()
  })

  it("fans out dismissal to the correct per-message subscriber", () => {
    const socket = createMockSocket()
    _testing.ensureListener(socket as never)

    const handlerA = vi.fn()
    const handlerB = vi.fn()

    // Simulate two components subscribing for different messages
    const setA = new Set([handlerA])
    const setB = new Set([handlerB])
    _testing.subscribers.set("msg_1", setA)
    _testing.subscribers.set("msg_2", setB)

    socket.emit("link_preview:dismissed", { messageId: "msg_1", linkPreviewId: "lp_1" })

    expect(handlerA).toHaveBeenCalledWith("lp_1")
    expect(handlerB).not.toHaveBeenCalled()
  })

  it("does not call handlers for unsubscribed messages", () => {
    const socket = createMockSocket()
    _testing.ensureListener(socket as never)

    socket.emit("link_preview:dismissed", { messageId: "msg_unknown", linkPreviewId: "lp_1" })
    // No error, no crash — unmatched messages are silently ignored
  })

  it("registers only one socket listener regardless of subscriber count", () => {
    const socket = createMockSocket()
    _testing.ensureListener(socket as never)
    _testing.ensureListener(socket as never) // idempotent

    expect(socket.on).toHaveBeenCalledTimes(1)
    expect(socket.listenerCount("link_preview:dismissed")).toBe(1)
  })

  it("re-registers listener when socket instance changes (reconnect)", () => {
    const socket1 = createMockSocket()
    const socket2 = createMockSocket()

    _testing.ensureListener(socket1 as never)
    expect(socket1.on).toHaveBeenCalledTimes(1)

    _testing.ensureListener(socket2 as never)
    expect(socket1.off).toHaveBeenCalledTimes(1)
    expect(socket2.on).toHaveBeenCalledTimes(1)
    expect(socket1.listenerCount("link_preview:dismissed")).toBe(0)
    expect(socket2.listenerCount("link_preview:dismissed")).toBe(1)
  })

  it("cleans up socket listener when reset is called", () => {
    const socket = createMockSocket()
    _testing.ensureListener(socket as never)
    _testing.subscribers.set("msg_1", new Set([vi.fn()]))

    _testing.reset()

    expect(socket.off).toHaveBeenCalledTimes(1)
    expect(_testing.subscribers.size).toBe(0)
    expect(socket.listenerCount("link_preview:dismissed")).toBe(0)
  })
})
