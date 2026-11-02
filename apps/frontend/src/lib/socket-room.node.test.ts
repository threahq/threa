import { afterEach, describe, it, expect, vi } from "vitest"
import type { Socket } from "socket.io-client"
import * as diagnosticsModule from "./connectivity-diagnostics/facade"
import { joinRoomBestEffort, joinRoomFireAndForget, joinRoomWithAck, SLOW_JOIN_ACK_MS } from "./socket-room"

type EventHandler = (...args: unknown[]) => void

class MockSocket {
  connected = true
  ackResult: { ok: boolean; error?: string } | null = { ok: true }
  ackDelayMs = 0
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
    if (event !== "join") {
      return this
    }

    this.emitCalls += 1
    const callback = args[1] as ((result?: { ok: boolean; error?: string }) => void) | undefined
    if (!callback || this.ackResult === null) {
      return this
    }

    setTimeout(() => callback(this.ackResult ?? undefined), this.ackDelayMs)
    return this
  }

  trigger(event: string, ...args: unknown[]) {
    const handlers = this.listeners.get(event)
    if (!handlers) return
    for (const handler of handlers) {
      handler(...args)
    }
  }
}

function asSocket(mock: MockSocket): Socket {
  return mock as unknown as Socket
}

function captureJoinEvents(): Array<{
  event: diagnosticsModule.ConnectivityEvent
  fields: diagnosticsModule.DiagnosticFields
}> {
  const events: Array<{ event: diagnosticsModule.ConnectivityEvent; fields: diagnosticsModule.DiagnosticFields }> = []
  vi.spyOn(diagnosticsModule, "beginConnectivityObservation").mockReturnValue({
    id: "join_1",
    record: (event, fields = {}) => events.push({ event, fields }),
    stall: () => () => {},
  })
  return events
}

afterEach(() => vi.restoreAllMocks())

describe("joinRoomWithAck", () => {
  it("should resolve when room join ack succeeds", async () => {
    const socket = new MockSocket()

    await expect(joinRoomWithAck(asSocket(socket), "ws:workspace_1")).resolves.toBeUndefined()
    expect(socket.emitCalls).toBe(1)
  })

  it("should wait for socket connect before joining", async () => {
    const socket = new MockSocket()
    socket.connected = false

    const joinPromise = joinRoomWithAck(asSocket(socket), "ws:workspace_1", { timeoutMs: 200 })

    setTimeout(() => {
      socket.connected = true
      socket.trigger("connect")
    }, 10)

    await expect(joinPromise).resolves.toBeUndefined()
    expect(socket.emitCalls).toBe(1)
  })

  it("should reject when ack returns error", async () => {
    const socket = new MockSocket()
    socket.ackResult = { ok: false, error: "Not authorized" }

    await expect(joinRoomWithAck(asSocket(socket), "ws:workspace_1")).rejects.toThrow("Not authorized")
  })

  it("should reject when ack times out", async () => {
    const socket = new MockSocket()
    socket.ackResult = null
    const events = captureJoinEvents()

    await expect(joinRoomWithAck(asSocket(socket), "ws:workspace_1", { timeoutMs: 20 })).rejects.toThrow(
      'Timed out waiting for join ack for room "ws:workspace_1"'
    )
    expect(events).toEqual([{ event: "room_join_failure", fields: { reason: "timeout" } }])
  })

  it("should not infer a timeout reason from a server error message", async () => {
    const socket = new MockSocket()
    socket.ackResult = { ok: false, error: "Timed out according to the server" }
    const events = captureJoinEvents()

    await expect(joinRoomWithAck(asSocket(socket), "ws:workspace_1")).rejects.toThrow(
      "Timed out according to the server"
    )
    expect(events).toEqual([{ event: "room_join_failure", fields: { reason: "unknown" } }])
  })

  it("should dedupe concurrent joins for the same room", async () => {
    const socket = new MockSocket()
    socket.ackDelayMs = 10

    await Promise.all([
      joinRoomWithAck(asSocket(socket), "ws:workspace_1"),
      joinRoomWithAck(asSocket(socket), "ws:workspace_1"),
    ])

    expect(socket.emitCalls).toBe(1)
  })

  it("should emit again after a previous join is completed", async () => {
    const socket = new MockSocket()

    await joinRoomWithAck(asSocket(socket), "ws:workspace_1")
    await joinRoomWithAck(asSocket(socket), "ws:workspace_1")

    expect(socket.emitCalls).toBe(2)
  })

  it("should reject if socket disconnects before ack", async () => {
    const socket = new MockSocket()
    socket.ackDelayMs = 50

    const joinPromise = joinRoomWithAck(asSocket(socket), "ws:workspace_1", { timeoutMs: 200 })
    setTimeout(() => {
      socket.trigger("disconnect", "transport close")
    }, 10)

    await expect(joinPromise).rejects.toThrow('Socket disconnected while joining room "ws:workspace_1"')
  })

  it("should reject immediately when signal is already aborted", async () => {
    const socket = new MockSocket()
    const controller = new AbortController()
    controller.abort()

    await expect(joinRoomWithAck(asSocket(socket), "ws:workspace_1", { signal: controller.signal })).rejects.toThrow(
      'Join aborted for room "ws:workspace_1"'
    )
    expect(socket.emitCalls).toBe(0)
  })

  it("should abort during connection wait without emitting join", async () => {
    const socket = new MockSocket()
    socket.connected = false
    const controller = new AbortController()
    const events = captureJoinEvents()

    const joinPromise = joinRoomWithAck(asSocket(socket), "ws:workspace_1", {
      timeoutMs: 200,
      signal: controller.signal,
    })

    setTimeout(() => controller.abort(), 10)

    await expect(joinPromise).rejects.toThrow('Join aborted for room "ws:workspace_1"')
    expect(socket.emitCalls).toBe(0)
    expect(events).toEqual([
      { event: "room_join_connection_wait", fields: {} },
      { event: "room_join_abort", fields: { reason: "abort" } },
    ])
  })
})

describe("join wave summary", () => {
  afterEach(() => vi.useRealTimers())

  it("should summarize a rejoin burst as one wave event and keep fast acks out of per-join rows", async () => {
    vi.useFakeTimers()
    const socket = new MockSocket()
    socket.ackDelayMs = 10
    diagnosticsModule.setSocketDiagnosticContext(socket, { connectionId: "conn_wave", generation: 3 })
    const perJoin = captureJoinEvents()
    const recorded: Array<{ event: diagnosticsModule.ConnectivityEvent; fields?: diagnosticsModule.DiagnosticFields }> =
      []
    vi.spyOn(diagnosticsModule, "recordConnectivityEvent").mockImplementation((event, fields) => {
      if (fields?.connectionId === "conn_wave") recorded.push({ event, fields })
    })

    const burst = [
      joinRoomWithAck(asSocket(socket), "ws:w:stream:a"),
      joinRoomWithAck(asSocket(socket), "ws:w:stream:b"),
    ]
    await vi.advanceTimersByTimeAsync(10)
    await Promise.all(burst)
    socket.ackResult = { ok: false, error: "denied" }
    socket.ackDelayMs = 30
    const late = joinRoomWithAck(asSocket(socket), "ws:w:stream:c").catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(30)
    await late
    expect(recorded).toEqual([])

    await vi.advanceTimersByTimeAsync(1000)
    expect(recorded).toEqual([
      {
        event: "room_join_wave",
        fields: { connectionId: "conn_wave", generation: 3, count: 3, failed: 1, p50Ms: 10, p95Ms: 10, maxMs: 10 },
      },
    ])
    expect(perJoin).toEqual([{ event: "room_join_failure", fields: { reason: "unknown" } }])
  })

  it("should start a new wave when the socket reconnects mid-wave", async () => {
    vi.useFakeTimers()
    const socket = new MockSocket()
    socket.ackDelayMs = 10
    diagnosticsModule.setSocketDiagnosticContext(socket, { connectionId: "conn_split", generation: 1 })
    captureJoinEvents()
    const recorded: Array<{ event: diagnosticsModule.ConnectivityEvent; fields?: diagnosticsModule.DiagnosticFields }> =
      []
    vi.spyOn(diagnosticsModule, "recordConnectivityEvent").mockImplementation((event, fields) => {
      if (fields?.connectionId === "conn_split") recorded.push({ event, fields })
    })

    const before = joinRoomWithAck(asSocket(socket), "ws:w:stream:a")
    diagnosticsModule.setSocketDiagnosticContext(socket, { connectionId: "conn_split", generation: 2 })
    const after = joinRoomWithAck(asSocket(socket), "ws:w:stream:b")
    await vi.advanceTimersByTimeAsync(10)
    await Promise.all([before, after])
    await vi.advanceTimersByTimeAsync(1000)

    const wave = { connectionId: "conn_split", count: 1, failed: 0, p50Ms: 10, p95Ms: 10, maxMs: 10 }
    expect(recorded).toEqual([
      { event: "room_join_wave", fields: { ...wave, generation: 1 } },
      { event: "room_join_wave", fields: { ...wave, generation: 2 } },
    ])
  })

  it("should measure ack latency from the emit, not from the connection wait", async () => {
    vi.useFakeTimers()
    const socket = new MockSocket()
    socket.connected = false
    socket.ackDelayMs = 10
    diagnosticsModule.setSocketDiagnosticContext(socket, { connectionId: "conn_wait", generation: 1 })
    const perJoin = captureJoinEvents()
    const recorded: Array<diagnosticsModule.DiagnosticFields | undefined> = []
    vi.spyOn(diagnosticsModule, "recordConnectivityEvent").mockImplementation((_event, fields) => {
      if (fields?.connectionId === "conn_wait") recorded.push(fields)
    })

    const join = joinRoomWithAck(asSocket(socket), "ws:w:stream:a", { timeoutMs: 10_000 })
    await vi.advanceTimersByTimeAsync(2 * SLOW_JOIN_ACK_MS)
    socket.connected = true
    socket.trigger("connect")
    await vi.advanceTimersByTimeAsync(10)
    await join
    await vi.advanceTimersByTimeAsync(1000)

    expect(perJoin).toEqual([{ event: "room_join_connection_wait", fields: {} }])
    expect(recorded).toEqual([
      { connectionId: "conn_wait", generation: 1, count: 1, failed: 0, p50Ms: 10, p95Ms: 10, maxMs: 10 },
    ])
  })

  it("should still record a slow ack individually", async () => {
    vi.useFakeTimers()
    const socket = new MockSocket()
    socket.ackDelayMs = SLOW_JOIN_ACK_MS
    const perJoin = captureJoinEvents()

    const join = joinRoomWithAck(asSocket(socket), "ws:w:stream:slow")
    await vi.advanceTimersByTimeAsync(SLOW_JOIN_ACK_MS)
    await join

    expect(perJoin).toEqual([{ event: "room_join_ack", fields: {} }])
  })
})

describe("join room logging", () => {
  it("does not log expected disconnect interruptions as errors", async () => {
    const socket = new MockSocket()
    socket.ackDelayMs = 50
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    const joinPromise = joinRoomBestEffort(asSocket(socket), "ws:workspace_1", "SyncEngine")
    setTimeout(() => {
      socket.trigger("disconnect", "transport close")
    }, 10)

    await joinPromise

    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it("does not log aborted fire-and-forget joins as errors", async () => {
    const socket = new MockSocket()
    socket.connected = false
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const controller = new AbortController()

    joinRoomFireAndForget(asSocket(socket), "ws:workspace_1", controller.signal, "StreamSocket")
    controller.abort()
    await Promise.resolve()

    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})
