import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import * as socketIoClient from "socket.io-client"
import { BotRuntimeTransport } from "./transport"
import type { BotRuntimeHello } from "./types"
import { buildBotSocketUrl, parseWsHint } from "./ws-hint"

const HELLO = {
  instanceId: "inst_42",
  runtimeKind: "pi-local",
  status: "available" as const,
  acceptingInvocations: true,
  supportedCapabilities: ["active-scratchpad"],
}

const LEGACY_PI_HELLO: BotRuntimeHello = {
  instanceId: "inst_legacy",
  runtimeKind: "pi-local",
  supportedCapabilities: ["active-scratchpad"],
}

it("keeps status fields optional for legacy Pi hello payloads", () => {
  expect(LEGACY_PI_HELLO).toEqual({
    instanceId: "inst_legacy",
    runtimeKind: "pi-local",
    supportedCapabilities: ["active-scratchpad"],
  })
})

function makeTransport(): BotRuntimeTransport {
  return new BotRuntimeTransport({
    baseUrl: "https://app.example.test",
    workspaceId: "ws_1",
    apiKey: "threa_bk_test",
    hello: HELLO,
  })
}

interface CapturedRequest {
  url: string
  method: string
  body: Record<string, unknown> | undefined
}

function stubFetch(responder: (req: CapturedRequest) => Response): CapturedRequest[] {
  const calls: CapturedRequest[] = []
  global.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString()
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
    const req = { url, method: init?.method ?? "GET", body }
    calls.push(req)
    return responder(req)
  }) as unknown as typeof fetch
  return calls
}

const originalFetch = global.fetch
afterEach(() => {
  global.fetch = originalFetch
})

describe("ws-hint helpers", () => {
  it("defaults path and namespace, then targets the /bot namespace", () => {
    const hint = parseWsHint({ url: "https://ws-eu.example.test" })
    expect(hint).toEqual({ url: "https://ws-eu.example.test", path: "/socket.io/", namespace: "/bot" })
    expect(buildBotSocketUrl(hint!)).toBe("https://ws-eu.example.test/bot")
  })

  it("preserves a query string when appending the namespace", () => {
    const hint = parseWsHint({ url: "https://ws.example.test/?region=eu" })!
    expect(buildBotSocketUrl(hint)).toBe("https://ws.example.test/bot?region=eu")
  })

  it("rejects a missing url", () => {
    expect(parseWsHint({ url: "" })).toBeUndefined()
    expect(parseWsHint({})).toBeUndefined()
  })
})

describe("HTTP fallback (no socket connected)", () => {
  it("unrolls a step batch into one POST per step with instanceId + claimToken", async () => {
    const calls = stubFetch(() => new Response(JSON.stringify({ data: {} }), { status: 200 }))
    const transport = makeTransport()

    await transport.recordSteps(
      "binv_1",
      "tok_1",
      [
        { stepType: "thinking", content: "a" },
        { stepType: "tool_call", content: "b" },
      ],
      "Working…"
    )

    expect(calls).toHaveLength(2)
    expect(calls[0]!.url).toBe("https://app.example.test/api/v1/workspaces/ws_1/bot-invocations/binv_1/steps")
    // One object comparison per POST (INV-24); each carries a minted idempotency key.
    expect(calls[0]!.body).toEqual({
      instanceId: "inst_42",
      claimToken: "tok_1",
      stepType: "thinking",
      content: "a",
      statusText: "Working…",
      clientStepId: expect.any(String),
    })
    expect(calls[1]!.body).toEqual({
      instanceId: "inst_42",
      claimToken: "tok_1",
      stepType: "tool_call",
      content: "b",
      statusText: "Working…",
      clientStepId: expect.any(String),
    })
    // Distinct keys per step so each frame dedups independently.
    expect(calls[0]!.body!.clientStepId).not.toBe(calls[1]!.body!.clientStepId)
  })

  it("renews over HTTP and reports notFound on a 404", async () => {
    const calls = stubFetch((req) =>
      req.url.includes("/renew") ? new Response(null, { status: 404 }) : new Response("{}", { status: 200 })
    )
    const transport = makeTransport()

    const result = await transport.renewClaim("binv_gone", "tok_1", 120)

    expect(result).toEqual({ notFound: true })
    expect(calls[0]!.url).toBe("https://app.example.test/api/v1/workspaces/ws_1/bot-invocations/binv_gone/renew")
    expect(calls[0]!.body).toEqual({ instanceId: "inst_42", claimToken: "tok_1", claimTtlSeconds: 120 })
  })

  it("renews over HTTP and reports found on a 200", async () => {
    stubFetch(() => new Response(JSON.stringify({ data: {} }), { status: 200 }))
    const transport = makeTransport()
    expect(await transport.renewClaim("binv_1", "tok_1", 120)).toEqual({ notFound: false })
  })

  it("posts the presence body verbatim", async () => {
    const calls = stubFetch(() => new Response(JSON.stringify({ data: {} }), { status: 200 }))
    const transport = makeTransport()
    const body = { runtimeKind: "pi-local", instanceId: "inst_42", status: "busy", acceptingInvocations: false }

    await transport.updatePresence(body)

    expect(calls[0]!.url).toBe("https://app.example.test/api/v1/workspaces/ws_1/bot-runtime/presence")
    expect(calls[0]!.body).toEqual(body)
  })

  it("does nothing for an empty step batch", async () => {
    const calls = stubFetch(() => new Response("{}", { status: 200 }))
    const transport = makeTransport()
    await transport.recordSteps("binv_1", "tok_1", [])
    expect(calls).toHaveLength(0)
  })
})

describe("WS frame sent but ack timed out (idempotency)", () => {
  // Drive the connected path without a real server: a socket whose
  // `.timeout().emit` fires the callback with a timeout error — i.e. the frame
  // was sent, the server just didn't ack in time (slow processing).
  function attachTimingOutSocket(transport: BotRuntimeTransport): void {
    const socket = {
      timeout: () => ({
        emit: (_event: string, _payload: unknown, cb: (err: unknown, ack?: unknown) => void) => {
          cb(new Error("operation has timed out"))
        },
      }),
    }
    ;(transport as unknown as { socket: unknown; connected: boolean; helloReady: boolean }).socket = socket
    ;(transport as unknown as { connected: boolean }).connected = true
    ;(transport as unknown as { helloReady: boolean }).helloReady = true
  }

  it("does NOT re-POST steps on a timed-out ack — the in-flight frame would duplicate the trace row", async () => {
    const calls = stubFetch(() => new Response("{}", { status: 200 }))
    const transport = makeTransport()
    attachTimingOutSocket(transport)

    await transport.recordSteps("binv_1", "tok_1", [{ stepType: "thinking", content: "a" }], "Working…")

    expect(calls).toHaveLength(0)
  })

  it("DOES retry renew over HTTP on a timed-out ack (idempotent CAS — the lease must not lapse)", async () => {
    const calls = stubFetch(() => new Response("{}", { status: 200 }))
    const transport = makeTransport()
    attachTimingOutSocket(transport)

    const result = await transport.renewClaim("binv_1", "tok_1", 120)

    expect(result).toEqual({ notFound: false })
    expect(calls.some((c) => c.url.includes("/bot-invocations/binv_1/renew"))).toBe(true)
  })

  it("DOES retry presence over HTTP on a timed-out ack (idempotent upsert)", async () => {
    const calls = stubFetch(() => new Response("{}", { status: 200 }))
    const transport = makeTransport()
    attachTimingOutSocket(transport)

    await transport.updatePresence({
      runtimeKind: "pi-local",
      instanceId: "inst_42",
      status: "busy",
      acceptingInvocations: false,
    })

    expect(calls.some((c) => c.url.includes("/bot-runtime/presence"))).toBe(true)
  })
})

describe("socket self-heal (the wedge that burns the edge quota)", () => {
  interface FakeSocket {
    handlers: Record<string, (...args: unknown[]) => void>
    connect: ReturnType<typeof mock>
    disconnect: ReturnType<typeof mock>
    removeAllListeners: ReturnType<typeof mock>
    on: (event: string, cb: (...args: unknown[]) => void) => FakeSocket
    emit: (...args: unknown[]) => void
    timeout: () => { emit: (...args: unknown[]) => void }
  }

  function makeFakeSocket(): FakeSocket {
    const socket: FakeSocket = {
      handlers: {},
      connect: mock(() => {}),
      disconnect: mock(() => {}),
      removeAllListeners: mock(() => {}),
      on(event, cb) {
        socket.handlers[event] = cb
        return socket
      },
      emit: (...args) => {
        const callback = args.at(-1)
        if (args[0] === "bot:hello" && typeof callback === "function") callback(null, { ok: true })
      },
      timeout: () => ({ emit: (...args) => socket.emit(...args) }),
    }
    return socket
  }

  function stubHintFetch(): CapturedRequest[] {
    return stubFetch(() => new Response(JSON.stringify({ wsUrl: "https://ws.example.test" }), { status: 200 }))
  }

  function makeSelfHealTransport(staleSocketRedialMs: number, reconnectionDelayMaxMs?: number): BotRuntimeTransport {
    return new BotRuntimeTransport({
      baseUrl: "https://app.example.test",
      workspaceId: "ws_1",
      apiKey: "threa_bk_test",
      hello: HELLO,
      staleSocketRedialMs,
      reconnectionDelayMaxMs,
    })
  }

  it("refreshes the initial and reconnect hello payloads immediately before emission", async () => {
    const fake = makeFakeSocket()
    const hellos: unknown[] = []
    fake.emit = (event, payload, callback) => {
      if (event === "bot:hello") {
        hellos.push(structuredClone(payload))
        if (typeof callback === "function") callback(null, { ok: true })
      }
    }
    const ioSpy = spyOn(socketIoClient, "io").mockReturnValue(fake as unknown as ReturnType<typeof socketIoClient.io>)
    try {
      stubHintFetch()
      let commands = ["stop"]
      let busy = true
      const transport = new BotRuntimeTransport({
        baseUrl: "https://app.example.test",
        workspaceId: "ws_1",
        apiKey: "threa_bk_test",
        hello: { ...HELLO, capabilities: {} },
        beforeHello: (hello) => {
          Object.assign(hello, {
            status: busy ? "busy" : "available",
            acceptingInvocations: !busy,
            capabilities: { sessionControlCommands: commands },
          })
        },
      })
      await transport.connect()
      fake.handlers.connect!()
      commands = ["stop", "reconnect"]
      busy = false
      fake.handlers.connect!()

      expect(hellos).toEqual([
        {
          ...HELLO,
          status: "busy",
          acceptingInvocations: false,
          capabilities: { sessionControlCommands: ["stop"] },
        },
        { ...HELLO, capabilities: { sessionControlCommands: ["stop", "reconnect"] } },
      ])
    } finally {
      ioSpy.mockRestore()
    }
  })

  it("does not send a second hello while the first acknowledgement is in flight", async () => {
    const fake = makeFakeSocket()
    let helloCalls = 0
    let acknowledge: ((error: unknown, ack: unknown) => void) | undefined
    fake.timeout = () => ({
      emit: (...args) => {
        helloCalls++
        acknowledge = args.at(-1) as (error: unknown, ack: unknown) => void
      },
    })
    const ioSpy = spyOn(socketIoClient, "io").mockReturnValue(fake as unknown as ReturnType<typeof socketIoClient.io>)
    try {
      stubHintFetch()
      const transport = makeSelfHealTransport(3 * 60 * 1000)
      await transport.connect()
      fake.handlers.connect!()
      await transport.connect()

      expect(helloCalls).toBe(1)
      expect(transport.socketConnected).toBe(false)

      acknowledge!(null, { ok: true })
      expect(transport.socketConnected).toBe(true)
    } finally {
      ioSpy.mockRestore()
    }
  })

  it("tears down a connected socket whose hello is rejected instead of treating it as healthy", async () => {
    const first = makeFakeSocket()
    const second = makeFakeSocket()
    first.timeout = () => ({
      emit: (...args) => {
        const callback = args.at(-1)
        if (typeof callback === "function") callback(null, { ok: false, error: "not registered" })
      },
    })
    const ioSpy = spyOn(socketIoClient, "io")
      .mockReturnValueOnce(first as unknown as ReturnType<typeof socketIoClient.io>)
      .mockReturnValueOnce(second as unknown as ReturnType<typeof socketIoClient.io>)
    try {
      stubHintFetch()
      const transport = makeSelfHealTransport(3 * 60 * 1000)
      await transport.connect()
      first.handlers.connect!()

      expect(transport.socketConnected).toBe(false)
      expect(first.disconnect).toHaveBeenCalledTimes(1)

      await transport.connect()
      expect(ioSpy).toHaveBeenCalledTimes(2)
      second.handlers.connect!()
      expect(transport.socketConnected).toBe(true)
    } finally {
      ioSpy.mockRestore()
    }
  })

  it("schedules a fresh connection when hello is rejected", async () => {
    const first = makeFakeSocket()
    const second = makeFakeSocket()
    first.timeout = () => ({
      emit: (...args) => {
        const callback = args.at(-1)
        if (typeof callback === "function") callback(null, { ok: false, error: "not registered" })
      },
    })
    const ioSpy = spyOn(socketIoClient, "io")
      .mockReturnValueOnce(first as unknown as ReturnType<typeof socketIoClient.io>)
      .mockReturnValueOnce(second as unknown as ReturnType<typeof socketIoClient.io>)
    try {
      stubHintFetch()
      const transport = makeSelfHealTransport(3 * 60 * 1000, 1)
      await transport.connect()
      first.handlers.connect!()
      await Bun.sleep(10)

      expect(ioSpy).toHaveBeenCalledTimes(2)
      second.handlers.connect!()
      expect(transport.socketConnected).toBe(true)
      transport.disconnect()
    } finally {
      ioSpy.mockRestore()
    }
  })

  it("redials after a server-initiated disconnect (Socket.IO won't reconnect on its own)", async () => {
    const fake = makeFakeSocket()
    const ioSpy = spyOn(socketIoClient, "io").mockReturnValue(fake as unknown as ReturnType<typeof socketIoClient.io>)
    try {
      stubHintFetch()
      const transport = makeSelfHealTransport(3 * 60 * 1000)
      await transport.connect()
      fake.handlers.connect!()
      expect(transport.socketConnected).toBe(true)

      fake.handlers.disconnect!("io server disconnect")
      expect(transport.socketConnected).toBe(false)
      expect(fake.connect).toHaveBeenCalledTimes(1)

      // Client-side drops are left to Socket.IO's own retry loop.
      fake.handlers.disconnect!("transport close")
      expect(fake.connect).toHaveBeenCalledTimes(1)
    } finally {
      ioSpy.mockRestore()
    }
  })

  it("routes bot:session_archived and bot:session_restored to their callbacks", async () => {
    const fake = makeFakeSocket()
    const ioSpy = spyOn(socketIoClient, "io").mockReturnValue(fake as unknown as ReturnType<typeof socketIoClient.io>)
    try {
      stubHintFetch()
      const archived: unknown[] = []
      const restored: unknown[] = []
      const transport = new BotRuntimeTransport({
        baseUrl: "https://app.example.test",
        workspaceId: "ws_1",
        apiKey: "threa_bk_test",
        hello: HELLO,
        callbacks: {
          onSessionArchived: (payload) => void archived.push(payload),
          onSessionRestored: (payload) => void restored.push(payload),
        },
      })
      await transport.connect()

      fake.handlers["bot:session_archived"]!({ runtimeSessionId: "rts_1" })
      fake.handlers["bot:session_restored"]!({ runtimeSessionId: "rts_1", rootStreamId: "stream_root" })

      expect(archived).toEqual([{ runtimeSessionId: "rts_1" }])
      expect(restored).toEqual([{ runtimeSessionId: "rts_1", rootStreamId: "stream_root" }])
    } finally {
      ioSpy.mockRestore()
    }
  })

  it("connect() leaves a fresh outage to Socket.IO but tears down and redials a stale one", async () => {
    const first = makeFakeSocket()
    const second = makeFakeSocket()
    const ioSpy = spyOn(socketIoClient, "io")
      .mockReturnValueOnce(first as unknown as ReturnType<typeof socketIoClient.io>)
      .mockReturnValueOnce(second as unknown as ReturnType<typeof socketIoClient.io>)
    try {
      stubHintFetch()
      // Stale threshold 0: any disconnected socket counts as wedged immediately.
      const transport = makeSelfHealTransport(0)
      await transport.connect()
      expect(ioSpy).toHaveBeenCalledTimes(1)

      await transport.connect()
      expect(first.removeAllListeners).toHaveBeenCalledTimes(1)
      expect(first.disconnect).toHaveBeenCalledTimes(1)
      expect(ioSpy).toHaveBeenCalledTimes(2)

      // A connected socket is never redialed.
      second.handlers.connect!()
      await transport.connect()
      expect(ioSpy).toHaveBeenCalledTimes(2)
    } finally {
      ioSpy.mockRestore()
    }
  })
})

describe("the routed writes never reject (best-effort contract)", () => {
  // Callers (the renew setInterval, pi-remote's per-step await) rely on these
  // resolving even when the HTTP fallback's fetch throws — the fallbacks swallow
  // internally. This locks that contract so a future edit can't reintroduce an
  // unhandled rejection / aborted turn.
  it("recordSteps / renewClaim / updatePresence all resolve when fetch throws", async () => {
    stubFetch(() => {
      throw new Error("network down")
    })
    const transport = makeTransport() // not connected → HTTP fallback path

    await expect(
      transport.recordSteps("binv_1", "tok_1", [{ stepType: "thinking", content: "a" }])
    ).resolves.toBeUndefined()
    await expect(transport.renewClaim("binv_1", "tok_1", 120)).resolves.toEqual({ notFound: false })
    await expect(
      transport.updatePresence({
        runtimeKind: "pi-local",
        instanceId: "inst_42",
        status: "busy",
        acceptingInvocations: false,
      })
    ).resolves.toBeUndefined()
  })
})
