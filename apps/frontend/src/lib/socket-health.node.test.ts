import { describe, it, expect } from "vitest"
import type { Socket } from "socket.io-client"
import { pingSocket } from "./socket-health"

type EventHandler = (...args: unknown[]) => void

class MockSocket {
  ackDelayMs: number | null = 0
  emitCalls = 0
  private listeners = new Map<string, Set<EventHandler>>()

  on(event: string, handler: EventHandler) {
    const handlers = this.listeners.get(event)
    if (handlers) {
      handlers.add(handler)
    } else {
      this.listeners.set(event, new Set([handler]))
    }
    return this
  }

  off(event: string, handler: EventHandler) {
    this.listeners.get(event)?.delete(handler)
    return this
  }

  emit(event: string, ...args: unknown[]) {
    if (event !== "health:ping") return this
    this.emitCalls += 1
    const callback = args[0] as ((result?: { ok: true }) => void) | undefined
    if (!callback) return this
    if (this.ackDelayMs === null) return this
    setTimeout(() => callback({ ok: true }), this.ackDelayMs)
    return this
  }

  trigger(event: string, ...args: unknown[]) {
    const handlers = this.listeners.get(event)
    if (!handlers) return
    for (const handler of handlers) {
      handler(...args)
    }
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0
  }
}

function asSocket(mock: MockSocket): Socket {
  return mock as unknown as Socket
}

describe("pingSocket", () => {
  it("resolves to true when ack fires before timeout", async () => {
    const socket = new MockSocket()
    socket.ackDelayMs = 5

    await expect(pingSocket(asSocket(socket), 100)).resolves.toBe(true)
    expect(socket.emitCalls).toBe(1)
  })

  it("resolves to false when ack does not fire before timeout", async () => {
    const socket = new MockSocket()
    socket.ackDelayMs = null

    await expect(pingSocket(asSocket(socket), 20)).resolves.toBe(false)
  })

  it("resolves to false when socket disconnects mid-probe", async () => {
    const socket = new MockSocket()
    socket.ackDelayMs = null

    const pingPromise = pingSocket(asSocket(socket), 200)
    setTimeout(() => socket.trigger("disconnect", "transport close"), 5)

    await expect(pingPromise).resolves.toBe(false)
  })

  it("cleans up the disconnect listener on successful ack", async () => {
    const socket = new MockSocket()
    socket.ackDelayMs = 5

    await pingSocket(asSocket(socket), 100)

    expect(socket.listenerCount("disconnect")).toBe(0)
  })

  it("cleans up the disconnect listener on timeout", async () => {
    const socket = new MockSocket()
    socket.ackDelayMs = null

    await pingSocket(asSocket(socket), 20)

    expect(socket.listenerCount("disconnect")).toBe(0)
  })

  it("cleans up the disconnect listener when triggered by disconnect", async () => {
    const socket = new MockSocket()
    socket.ackDelayMs = null

    const pingPromise = pingSocket(asSocket(socket), 200)
    setTimeout(() => socket.trigger("disconnect", "transport close"), 5)
    await pingPromise

    expect(socket.listenerCount("disconnect")).toBe(0)
  })

  it("ignores a late ack arriving after timeout", async () => {
    const socket = new MockSocket()
    socket.ackDelayMs = 40

    const result = await pingSocket(asSocket(socket), 10)
    expect(result).toBe(false)

    // Wait for the late ack to fire; the promise already resolved, so nothing should break.
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(socket.listenerCount("disconnect")).toBe(0)
  })
})
