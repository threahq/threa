import { describe, expect, it, mock } from "bun:test"
import type { Server } from "socket.io"
import type { BotRuntimeService } from "./service"
import type { BotApiKeyService } from "../public-api"
import type { BotInvocation, BotRuntimeSessionLink, StreamActiveActor } from "./repository"
import { attachBotNamespace, type BotHelloResponse } from "./socket-handler"
import { BotSocketRegistry } from "./bot-socket-registry"

// Minimal fakes that exercise the public surface of the namespace handler
// without spinning up Socket.IO: a `namespace` that captures the connection
// callback, and a `socket` that lets the test trigger arbitrary events.

interface FakeSocket {
  data: { bot?: { workspaceId: string; botId: string; keyId: string } }
  handshake: { auth: Record<string, unknown>; headers: Record<string, unknown> }
  join: (room: string) => void
  leave: (room: string) => void
  disconnect: (close?: boolean) => void
  on: (event: string, cb: (...args: unknown[]) => unknown) => void
  trigger: (event: string, ...args: unknown[]) => Promise<unknown> | unknown
  rooms: Set<string>
  joinOrder: string[]
  disconnected: boolean
}

function makeFakeSocket(): FakeSocket {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const rooms = new Set<string>()
  const joinOrder: string[] = []
  let disconnected = false
  return {
    data: {
      bot: { workspaceId: "ws_1", botId: "bot_alice", keyId: "key_1" },
    },
    handshake: { auth: { token: "threa_bk_test" }, headers: {} },
    join(room: string) {
      rooms.add(room)
      joinOrder.push(room)
    },
    leave(room: string) {
      rooms.delete(room)
    },
    disconnect(_close?: boolean) {
      disconnected = true
    },
    on(event: string, cb: (...args: unknown[]) => unknown) {
      handlers.set(event, cb)
    },
    trigger(event: string, ...args: unknown[]) {
      return handlers.get(event)?.(...args)
    },
    rooms,
    joinOrder,
    get disconnected() {
      return disconnected
    },
  }
}

function makeBootstrap(
  overrides: {
    available?: BotInvocation[]
    ownedClaims?: BotInvocation[]
    activeActorByStream?: StreamActiveActor[]
    activeSessionLinks?: BotRuntimeSessionLink[]
    serverGeneratedAt?: Date
  } = {}
) {
  return {
    serverGeneratedAt: overrides.serverGeneratedAt ?? new Date("2026-05-26T12:00:00Z"),
    available: overrides.available ?? [],
    ownedClaims: overrides.ownedClaims ?? [],
    activeActorByStream: overrides.activeActorByStream ?? [],
    activeSessionLinks: overrides.activeSessionLinks ?? [],
  }
}

function setup(overrides?: {
  upsertPresenceFromBotKey?: (...args: unknown[]) => Promise<unknown>
  getBootstrapForRuntime?: (...args: unknown[]) => Promise<unknown>
  validateKey?: (...args: unknown[]) => Promise<unknown>
}) {
  const botRuntimeService = {
    upsertPresenceFromBotKey: mock(overrides?.upsertPresenceFromBotKey ?? (async () => ({}))),
    getBootstrapForRuntime: mock(overrides?.getBootstrapForRuntime ?? (async () => makeBootstrap())),
  } as unknown as BotRuntimeService

  const botApiKeyService = {
    validateKey: mock(overrides?.validateKey ?? (async () => ({}))),
  } as unknown as BotApiKeyService

  const botSocketRegistry = new BotSocketRegistry()

  let connectionHandler: ((socket: FakeSocket) => void) | undefined
  const namespace = {
    use: mock(() => {}),
    on: (event: string, cb: (socket: FakeSocket) => void) => {
      if (event === "connection") connectionHandler = cb
    },
  }
  const io = { of: mock(() => namespace) } as unknown as Server

  attachBotNamespace({
    io,
    botRuntimeService,
    botApiKeyService,
    botSocketRegistry,
    // Disable revalidation timer in tests — the periodic ticker is covered
    // elsewhere and would otherwise leak between tests.
    keyRevalidationIntervalMs: 60_000_000,
  })

  const socket = makeFakeSocket()
  connectionHandler!(socket)

  return { socket, botRuntimeService, botApiKeyService, botSocketRegistry }
}

const VALID_HELLO = {
  instanceId: "inst_42",
  runtimeKind: "pi-local" as const,
  supportedCapabilities: ["active-scratchpad"] as const,
}

describe("attachBotNamespace bot:hello", () => {
  it("joins workspace + bot + instance rooms before the bootstrap read", async () => {
    const callOrder: string[] = []
    const { socket } = setup({
      upsertPresenceFromBotKey: async () => {
        callOrder.push("upsertPresence")
      },
      getBootstrapForRuntime: async () => {
        callOrder.push("getBootstrap")
        return makeBootstrap()
      },
    })
    const ack = mock((_r: BotHelloResponse) => {})

    await socket.trigger("bot:hello", VALID_HELLO, ack)

    // Workspace-wide room joined on connect; bot/instance rooms joined
    // BEFORE getBootstrapForRuntime to close the event-loss window.
    expect(socket.rooms.has("bot:ws_1")).toBe(true)
    expect(socket.rooms.has("bot:ws_1:bot:bot_alice")).toBe(true)
    expect(socket.rooms.has("bot:ws_1:bot:bot_alice:instance:inst_42")).toBe(true)
    const botRoomIdx = socket.joinOrder.indexOf("bot:ws_1:bot:bot_alice")
    const instRoomIdx = socket.joinOrder.indexOf("bot:ws_1:bot:bot_alice:instance:inst_42")
    expect(botRoomIdx).toBeGreaterThan(-1)
    expect(instRoomIdx).toBeGreaterThan(-1)
    expect(callOrder).toEqual(["upsertPresence", "getBootstrap"])
    expect(ack.mock.calls[0]?.[0]).toMatchObject({ ok: true })
  })

  it("joins session room when runtimeSessionId is present", async () => {
    const { socket } = setup()
    const ack = mock((_r: BotHelloResponse) => {})

    await socket.trigger("bot:hello", { ...VALID_HELLO, runtimeSessionId: "sess_1" }, ack)

    expect(socket.rooms.has("bot:ws_1:bot:bot_alice:session:sess_1")).toBe(true)
  })

  it("rejects a second bot:hello on the same connection", async () => {
    const { socket } = setup()
    const ack1 = mock((_r: BotHelloResponse) => {})
    const ack2 = mock((_r: BotHelloResponse) => {})

    await socket.trigger("bot:hello", VALID_HELLO, ack1)
    await socket.trigger("bot:hello", VALID_HELLO, ack2)

    expect(ack1.mock.calls[0]?.[0]).toMatchObject({ ok: true })
    expect(ack2.mock.calls[0]?.[0]).toMatchObject({
      ok: false,
      error: "bot:hello already received on this connection",
    })
  })

  it("rejects a concurrent bot:hello while the first is still in flight", async () => {
    // Two hello frames arriving before the first chain settles must not both
    // pass the joined-guard and double-upsert presence. The helloInFlight
    // sync flag closes that race.
    let resolveUpsert: (() => void) | undefined
    const upsert = mock(
      () =>
        new Promise<void>((resolve) => {
          resolveUpsert = resolve
        })
    )
    const { socket, botRuntimeService } = setup({
      upsertPresenceFromBotKey: upsert as never,
    })
    const ack1 = mock((_r: BotHelloResponse) => {})
    const ack2 = mock((_r: BotHelloResponse) => {})

    // Fire both before awaiting either — both event handlers run their
    // sync prefix immediately, so the second one must see helloInFlight.
    const p1 = socket.trigger("bot:hello", VALID_HELLO, ack1)
    const p2 = socket.trigger("bot:hello", VALID_HELLO, ack2)
    resolveUpsert!()
    await Promise.all([p1, p2])

    expect(ack2.mock.calls[0]?.[0]).toMatchObject({
      ok: false,
      error: "bot:hello already received on this connection",
    })
    expect((botRuntimeService.upsertPresenceFromBotKey as ReturnType<typeof mock>).mock.calls.length).toBe(1)
  })

  it("leaves rooms and clears the in-flight flag when bootstrap fails, allowing a retry", async () => {
    let firstCall = true
    const { socket, botRuntimeService } = setup({
      getBootstrapForRuntime: async () => {
        if (firstCall) {
          firstCall = false
          throw new Error("transient DB error")
        }
        return makeBootstrap()
      },
    })
    const ack1 = mock((_r: BotHelloResponse) => {})
    const ack2 = mock((_r: BotHelloResponse) => {})

    await socket.trigger("bot:hello", VALID_HELLO, ack1)

    expect(ack1.mock.calls[0]?.[0]).toMatchObject({ ok: false, error: "Internal error during bootstrap" })
    expect(socket.rooms.has("bot:ws_1:bot:bot_alice")).toBe(false)
    expect(socket.rooms.has("bot:ws_1:bot:bot_alice:instance:inst_42")).toBe(false)

    // Retry succeeds — the helloInFlight flag must have cleared.
    await socket.trigger("bot:hello", VALID_HELLO, ack2)

    expect(ack2.mock.calls[0]?.[0]).toMatchObject({ ok: true })
    expect(socket.rooms.has("bot:ws_1:bot:bot_alice")).toBe(true)
    expect((botRuntimeService.upsertPresenceFromBotKey as ReturnType<typeof mock>).mock.calls.length).toBe(2)
  })

  it("rejects payloads with an instanceId that contains characters outside [A-Za-z0-9_-]", async () => {
    const { socket, botRuntimeService } = setup()
    const ack = mock((_r: BotHelloResponse) => {})

    await socket.trigger("bot:hello", { ...VALID_HELLO, instanceId: "inst 42 with spaces" }, ack)

    expect(ack.mock.calls[0]?.[0]).toMatchObject({ ok: false, error: "Invalid bot:hello payload" })
    expect((botRuntimeService.upsertPresenceFromBotKey as ReturnType<typeof mock>).mock.calls.length).toBe(0)
  })

  it("rejects payloads with an instanceId longer than 64 characters", async () => {
    const { socket } = setup()
    const ack = mock((_r: BotHelloResponse) => {})

    await socket.trigger("bot:hello", { ...VALID_HELLO, instanceId: "a".repeat(65) }, ack)

    expect(ack.mock.calls[0]?.[0]).toMatchObject({ ok: false, error: "Invalid bot:hello payload" })
  })

  it("rejects payloads with an empty supportedCapabilities array", async () => {
    const { socket } = setup()
    const ack = mock((_r: BotHelloResponse) => {})

    await socket.trigger("bot:hello", { ...VALID_HELLO, supportedCapabilities: [] }, ack)

    expect(ack.mock.calls[0]?.[0]).toMatchObject({ ok: false, error: "Invalid bot:hello payload" })
  })

  it("forwards sinceCursor to the bootstrap service as a Date", async () => {
    const { socket, botRuntimeService } = setup()
    const ack = mock((_r: BotHelloResponse) => {})

    await socket.trigger("bot:hello", { ...VALID_HELLO, sinceCursor: "2026-05-26T11:00:00.000Z" }, ack)

    const call = (botRuntimeService.getBootstrapForRuntime as ReturnType<typeof mock>).mock.calls[0]?.[0] as {
      sinceCursor: Date
    }
    expect(call.sinceCursor).toBeInstanceOf(Date)
    expect(call.sinceCursor.toISOString()).toBe("2026-05-26T11:00:00.000Z")
  })

  it("serializes activeActorByStream and activeSessionLinks in the ack", async () => {
    const actor: StreamActiveActor = {
      id: "saa_1",
      workspaceId: "ws_1",
      rootStreamId: "stream_root",
      actorType: "bot",
      actorId: "bot_alice",
      createdBy: "usr_owner",
      createdAt: new Date("2026-05-26T11:00:00Z"),
      updatedAt: new Date("2026-05-26T11:30:00Z"),
    }
    const link: BotRuntimeSessionLink = {
      id: "brsl_1",
      workspaceId: "ws_1",
      botId: "bot_alice",
      runtimeKind: "pi-local",
      instanceId: "inst_42",
      runtimeSessionId: "sess_1",
      rootStreamId: "stream_root",
      activeStreamId: "stream_active",
      status: "active",
      linkedBy: "usr_owner",
      metadata: {},
      lastSeenAt: new Date("2026-05-26T11:45:00Z"),
      createdAt: new Date("2026-05-26T11:00:00Z"),
      updatedAt: new Date("2026-05-26T11:45:00Z"),
    }
    const { socket } = setup({
      getBootstrapForRuntime: async () => makeBootstrap({ activeActorByStream: [actor], activeSessionLinks: [link] }),
    })
    const ack = mock((_r: BotHelloResponse) => {})

    await socket.trigger("bot:hello", VALID_HELLO, ack)

    const resp = ack.mock.calls[0]?.[0] as BotHelloResponse & { ok: true }
    expect(resp.ok).toBe(true)
    expect(resp.activeActorByStream).toEqual([
      { rootStreamId: "stream_root", actorType: "bot", actorId: "bot_alice", updatedAt: actor.updatedAt.toISOString() },
    ])
    expect(resp.activeSessionLinks).toEqual([
      {
        rootStreamId: "stream_root",
        activeStreamId: "stream_active",
        runtimeSessionId: "sess_1",
        status: "active",
        lastSeenAt: link.lastSeenAt!.toISOString(),
      },
    ])
  })
})
