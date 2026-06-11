import { describe, it, expect, vi } from "vitest"
import type { Socket } from "socket.io-client"
import { SocketEventGate } from "./socket-event-gate"

type Handler = (...args: unknown[]) => void

class FakeSocket {
  private listeners = new Map<string, Set<Handler>>()

  on(event: string, handler: Handler) {
    const set = this.listeners.get(event) ?? new Set()
    set.add(handler)
    this.listeners.set(event, set)
    return this
  }

  off(event: string, handler: Handler) {
    this.listeners.get(event)?.delete(handler)
    return this
  }

  trigger(event: string, ...args: unknown[]) {
    for (const handler of this.listeners.get(event) ?? []) handler(...args)
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0
  }
}

function asSocket(fake: FakeSocket): Socket {
  return fake as unknown as Socket
}

const WS = "ws_1"

describe("SocketEventGate", () => {
  it("forwards live socket events to every registered handler when open", () => {
    const gate = new SocketEventGate(WS)
    const socket = new FakeSocket()
    const workspaceHandler = vi.fn()
    const streamHandler = vi.fn()
    gate.on("stream:member_added", workspaceHandler)
    gate.on("stream:member_added", streamHandler)
    gate.attach(asSocket(socket))

    const payload = { workspaceId: WS, syncId: "5" }
    socket.trigger("stream:member_added", payload)

    expect(workspaceHandler).toHaveBeenCalledWith(payload)
    expect(streamHandler).toHaveBeenCalledWith(payload)
  })

  it("reports applied syncIds for this workspace's live events and ignores the rest", () => {
    const applied: string[] = []
    const gate = new SocketEventGate(WS, { onApplied: (syncId) => applied.push(syncId) })
    const socket = new FakeSocket()
    gate.on("message:created", vi.fn())
    gate.attach(asSocket(socket))

    socket.trigger("message:created", { workspaceId: WS, syncId: "7" })
    socket.trigger("message:created", { workspaceId: "ws_other", syncId: "9" })
    socket.trigger("message:created", { workspaceId: WS })

    expect(applied).toEqual(["7"])
  })

  it("buffers this workspace's syncId-bearing events while paused and passes others through", () => {
    const gate = new SocketEventGate(WS)
    const socket = new FakeSocket()
    const handler = vi.fn()
    gate.on("message:created", handler)
    gate.on("bot_runtime:presence", handler)
    gate.attach(asSocket(socket))

    gate.pause()
    socket.trigger("message:created", { workspaceId: WS, syncId: "5" })
    socket.trigger("bot_runtime:presence", { workspaceId: WS, botId: "bot_1" })
    socket.trigger("message:created", { workspaceId: "ws_other", syncId: "6" })

    expect(handler).toHaveBeenCalledTimes(2)
    expect(handler).toHaveBeenCalledWith({ workspaceId: WS, botId: "bot_1" })
    expect(handler).toHaveBeenCalledWith({ workspaceId: "ws_other", syncId: "6" })
  })

  it("splices buffered events in ascending syncId order, applying only those the predicate admits", async () => {
    const applied: string[] = []
    const gate = new SocketEventGate(WS, { onApplied: (syncId) => applied.push(syncId) })
    const socket = new FakeSocket()
    const seen: string[] = []
    gate.on("message:created", (payload: unknown) => {
      seen.push((payload as { syncId: string }).syncId)
    })
    gate.attach(asSocket(socket))

    gate.pause()
    socket.trigger("message:created", { workspaceId: WS, syncId: "12" })
    socket.trigger("message:created", { workspaceId: WS, syncId: "9" })
    socket.trigger("message:created", { workspaceId: WS, syncId: "11" })
    expect(seen).toEqual([])

    await gate.resume((_eventType, syncId) => syncId > 10n)

    expect(seen).toEqual(["11", "12"])
    expect(applied).toEqual(["11", "12"])

    // Gate is open again: live events apply immediately.
    socket.trigger("message:created", { workspaceId: WS, syncId: "13" })
    expect(seen).toEqual(["11", "12", "13"])
  })

  it("lets the predicate admit skipped-type events below the position during the splice", async () => {
    const gate = new SocketEventGate(WS)
    const socket = new FakeSocket()
    const handler = vi.fn()
    gate.on("stream:activity", handler)
    gate.attach(asSocket(socket))

    gate.pause()
    socket.trigger("stream:activity", { workspaceId: WS, syncId: "3" })
    await gate.resume((eventType, syncId) => syncId > 10n || eventType === "stream:activity")

    expect(handler).toHaveBeenCalledWith({ workspaceId: WS, syncId: "3" })
  })

  it("keeps draining events that arrive while the splice is running", async () => {
    const gate = new SocketEventGate(WS)
    const socket = new FakeSocket()
    const seen: string[] = []
    let injected = false
    gate.on("message:created", async (payload: unknown) => {
      seen.push((payload as { syncId: string }).syncId)
      if (!injected) {
        injected = true
        // Still paused mid-splice: this buffers and is drained by the same loop.
        socket.trigger("message:created", { workspaceId: WS, syncId: "20" })
      }
    })
    gate.attach(asSocket(socket))

    gate.pause()
    socket.trigger("message:created", { workspaceId: WS, syncId: "15" })
    await gate.resume(() => true)

    expect(seen).toEqual(["15", "20"])
  })

  it("dispatch awaits all handlers and survives a rejecting one", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const gate = new SocketEventGate(WS)
      let settled = false
      gate.on("saved:upserted", async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        settled = true
      })
      gate.on("saved:upserted", async () => {
        throw new Error("boom")
      })

      await gate.dispatch("saved:upserted", { workspaceId: WS })

      expect(settled).toBe(true)
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it("falls back to immediate application when the pause buffer overflows", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const gate = new SocketEventGate(WS, { bufferLimit: 1 })
      const socket = new FakeSocket()
      const handler = vi.fn()
      gate.on("message:created", handler)
      gate.attach(asSocket(socket))

      gate.pause()
      socket.trigger("message:created", { workspaceId: WS, syncId: "1" })
      socket.trigger("message:created", { workspaceId: WS, syncId: "2" })

      // First buffered, second passed through live.
      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler).toHaveBeenCalledWith({ workspaceId: WS, syncId: "2" })
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("removes the socket forwarder when the last handler for a type unregisters", () => {
    const gate = new SocketEventGate(WS)
    const socket = new FakeSocket()
    const a = vi.fn()
    const b = vi.fn()
    gate.attach(asSocket(socket))
    gate.on("message:created", a)
    gate.on("message:created", b)
    expect(socket.listenerCount("message:created")).toBe(1)

    gate.off("message:created", a)
    expect(socket.listenerCount("message:created")).toBe(1)
    gate.off("message:created", b)
    expect(socket.listenerCount("message:created")).toBe(0)
  })

  it("moves registrations to a newly attached socket and survives reconnects on the same socket", () => {
    const gate = new SocketEventGate(WS)
    const first = new FakeSocket()
    const second = new FakeSocket()
    const handler = vi.fn()
    gate.on("message:created", handler)
    gate.attach(asSocket(first))
    gate.attach(asSocket(first)) // reconnect with same instance: no duplicate forwarders
    expect(first.listenerCount("message:created")).toBe(1)

    gate.attach(asSocket(second))
    expect(first.listenerCount("message:created")).toBe(0)

    second.trigger("message:created", { workspaceId: WS, syncId: "4" })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("dispose drops buffered events without applying them", async () => {
    const gate = new SocketEventGate(WS)
    const socket = new FakeSocket()
    const handler = vi.fn()
    gate.on("message:created", handler)
    gate.attach(asSocket(socket))

    gate.pause()
    socket.trigger("message:created", { workspaceId: WS, syncId: "5" })
    gate.dispose()
    await gate.resume(() => true)

    expect(handler).not.toHaveBeenCalled()
    expect(socket.listenerCount("message:created")).toBe(0)
  })
})
