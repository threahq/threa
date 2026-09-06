import { describe, expect, it, mock } from "bun:test"
import type { Server } from "socket.io"
import { HttpError } from "@threahq/backend-common"
import type { BotRuntimeService } from "./service"
import type { BotApiKeyService } from "../public-api"
import type { BotInvocation, BotInvocationCancellation, BotRuntimeSessionLink, StreamActiveActor } from "./repository"
import {
  attachBotNamespace,
  type BotHelloResponse,
  type BotSupervisorSubscribeResponse,
  type BotWriteAck,
} from "./socket-handler"
import type { BotRuntimeWriteOps } from "./runtime-write-ops"
import { BotSocketRegistry } from "./bot-socket-registry"
import type { AccessLogService } from "../access-log"

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
    recentCancellations?: BotInvocationCancellation[]
    activeActorByStream?: StreamActiveActor[]
    activeSessionLinks?: BotRuntimeSessionLink[]
    serverGeneratedAt?: Date
  } = {}
) {
  return {
    serverGeneratedAt: overrides.serverGeneratedAt ?? new Date("2026-05-26T12:00:00Z"),
    available: overrides.available ?? [],
    ownedClaims: overrides.ownedClaims ?? [],
    recentCancellations: overrides.recentCancellations ?? [],
    activeActorByStream: overrides.activeActorByStream ?? [],
    activeSessionLinks: overrides.activeSessionLinks ?? [],
  }
}

function setup(overrides?: {
  upsertPresenceFromBotKey?: (...args: unknown[]) => Promise<unknown>
  getBootstrapForRuntime?: (...args: unknown[]) => Promise<unknown>
  validateKey?: (...args: unknown[]) => Promise<unknown>
  applyPresence?: (...args: unknown[]) => Promise<unknown>
  touchPresence?: (...args: unknown[]) => Promise<unknown>
  renewClaim?: (...args: unknown[]) => Promise<unknown>
  recordSteps?: (...args: unknown[]) => Promise<unknown>
}) {
  const botRuntimeService = {
    upsertPresenceFromBotKey: mock(overrides?.upsertPresenceFromBotKey ?? (async () => ({}))),
    getBootstrapForRuntime: mock(overrides?.getBootstrapForRuntime ?? (async () => makeBootstrap())),
  } as unknown as BotRuntimeService

  const botRuntimeWriteOps = {
    applyPresence: mock(overrides?.applyPresence ?? (async () => ({}))),
    touchPresence: mock(overrides?.touchPresence ?? (async () => {})),
    renewClaim: mock(
      overrides?.renewClaim ?? (async () => ({ invocationId: "binv_1", status: "claimed", claimExpiresAt: null }))
    ),
    recordSteps: mock(
      overrides?.recordSteps ?? (async () => ({ invocationId: "binv_1", sessionId: "binv_1", steps: [] }))
    ),
  } as unknown as BotRuntimeWriteOps

  const botApiKeyService = {
    validateKey: mock(overrides?.validateKey ?? (async () => ({}))),
  } as unknown as BotApiKeyService

  const botSocketRegistry = new BotSocketRegistry()

  const accessLogService = { record: mock(() => {}) } as unknown as AccessLogService

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
    botRuntimeWriteOps,
    botApiKeyService,
    botSocketRegistry,
    accessLogService,
    // Disable revalidation timer in tests — the periodic ticker is covered
    // elsewhere and would otherwise leak between tests.
    keyRevalidationIntervalMs: 60_000_000,
  })

  const socket = makeFakeSocket()
  connectionHandler!(socket)

  return { socket, botRuntimeService, botRuntimeWriteOps, botApiKeyService, botSocketRegistry, accessLogService }
}

const VALID_HELLO = {
  instanceId: "inst_42",
  runtimeKind: "pi-local" as const,
  supportedCapabilities: ["active-scratchpad"] as const,
}

describe("attachBotNamespace supervisor subscription", () => {
  it("joins a bot-scoped supervisor room without writing presence", async () => {
    const { socket, botRuntimeService } = setup()
    const ack = mock((_response: BotSupervisorSubscribeResponse) => {})

    await socket.trigger("bot:supervisor:subscribe", ack)

    expect(socket.rooms.has("bot:ws_1:bot:bot_alice:supervisor")).toBe(true)
    expect(botRuntimeService.upsertPresenceFromBotKey).not.toHaveBeenCalled()
    expect(ack.mock.calls[0]?.[0]).toEqual({ ok: true })
  })

  it("does not allow one connection to mix supervisor and runtime roles", async () => {
    const { socket } = setup()
    const supervisorAck = mock((_response: BotSupervisorSubscribeResponse) => {})
    const helloAck = mock((_response: BotHelloResponse) => {})

    await socket.trigger("bot:supervisor:subscribe", supervisorAck)
    await socket.trigger("bot:hello", VALID_HELLO, helloAck)

    expect(helloAck.mock.calls[0]?.[0]).toEqual({
      ok: false,
      error: "supervisor connections cannot register a runtime",
    })
  })

  it("rejects every runtime write frame after supervisor subscription", async () => {
    const { socket, botRuntimeWriteOps } = setup()
    await socket.trigger(
      "bot:supervisor:subscribe",
      mock(() => {})
    )
    const events = [
      "bot:presence:update",
      "bot:invocation:renew",
      "bot:invocation:steps",
      "bot:invocation:sealed-steps",
    ]

    for (const event of events) {
      const ack = mock((_response: BotWriteAck) => {})
      await socket.trigger(event, {}, ack)
      expect(ack.mock.calls[0]?.[0]).toEqual({
        ok: false,
        code: "FORBIDDEN",
        message: "Supervisor connections are read-only",
      })
    }
    expect(botRuntimeWriteOps.applyPresence).not.toHaveBeenCalled()
    expect(botRuntimeWriteOps.renewClaim).not.toHaveBeenCalled()
    expect(botRuntimeWriteOps.recordSteps).not.toHaveBeenCalled()
  })
})

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

  it("records audit subscribe rows for the workspace room at connect and the bot rooms at hello", async () => {
    const { socket, accessLogService } = setup()
    const record = (accessLogService as unknown as { record: ReturnType<typeof mock> }).record

    // Connect-time subscribe for the workspace-wide bot room. The per-connection
    // sconn id is the auth_ref that pairs this subscribe with its unsubscribe.
    const connectRow = record.mock.calls[0]?.[0] as { authRef: string }
    expect(connectRow).toMatchObject({
      workspaceId: "ws_1",
      actorType: "bot",
      actorId: "bot_alice",
      operation: "socket.subscribe",
      accessKind: "subscribe",
      outcome: "success",
      subjects: [{ type: "workspace", id: "ws_1" }],
    })
    const sconn = connectRow.authRef
    expect(sconn).toMatch(/^sconn_/)

    await socket.trigger(
      "bot:hello",
      VALID_HELLO,
      mock((_r: BotHelloResponse) => {})
    )

    const helloRow = record.mock.calls[1]?.[0]
    expect(helloRow).toMatchObject({
      actorType: "bot",
      actorId: "bot_alice",
      operation: "socket.subscribe",
      accessKind: "subscribe",
      authRef: sconn,
      subjects: [{ type: "bot", id: "bot_alice" }],
    })

    await socket.trigger("disconnect")
    // Both intervals close on disconnect: the workspace-room row and the bot-room
    // row, each reusing this connection's sconn so subscribe/unsubscribe pair.
    const unsubscribeRows = record.mock.calls.slice(2).map((c: unknown[]) => c[0])
    expect(unsubscribeRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: "socket.unsubscribe",
          accessKind: "unsubscribe",
          actorId: "bot_alice",
          authRef: sconn,
          subjects: [{ type: "workspace", id: "ws_1" }],
        }),
        expect.objectContaining({
          operation: "socket.unsubscribe",
          accessKind: "unsubscribe",
          actorId: "bot_alice",
          authRef: sconn,
          subjects: [{ type: "bot", id: "bot_alice" }],
        }),
      ])
    )
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

  it("treats omitted hello manifest as an explicit legacy registration", async () => {
    const { socket, botRuntimeService } = setup()
    const ack = mock((_r: BotHelloResponse) => {})

    await socket.trigger("bot:hello", VALID_HELLO, ack)

    const call = (botRuntimeService.upsertPresenceFromBotKey as ReturnType<typeof mock>).mock.calls[0]?.[0] as {
      manifest: unknown
    }
    expect(call.manifest).toBeNull()
  })

  it("forwards a registered BIK (publicKey + publicKeyId) to presence", async () => {
    const { socket, botRuntimeService } = setup()
    const ack = mock((_r: BotHelloResponse) => {})
    const publicKey = Buffer.alloc(32, 7).toString("base64")

    await socket.trigger("bot:hello", { ...VALID_HELLO, publicKey, publicKeyId: "bik_abc12" }, ack)

    expect(ack.mock.calls[0]?.[0]).toMatchObject({ ok: true })
    const call = (botRuntimeService.upsertPresenceFromBotKey as ReturnType<typeof mock>).mock.calls[0]?.[0] as {
      publicKey: string
      publicKeyId: string
    }
    expect(call.publicKey).toBe(publicKey)
    expect(call.publicKeyId).toBe("bik_abc12")
  })

  it("rejects a half-registered BIK (publicKey without publicKeyId)", async () => {
    const { socket, botRuntimeService } = setup()
    const ack = mock((_r: BotHelloResponse) => {})

    await socket.trigger("bot:hello", { ...VALID_HELLO, publicKey: Buffer.alloc(32).toString("base64") }, ack)

    expect(ack.mock.calls[0]?.[0]).toMatchObject({ ok: false, error: "Invalid bot:hello payload" })
    expect((botRuntimeService.upsertPresenceFromBotKey as ReturnType<typeof mock>).mock.calls.length).toBe(0)
  })

  it("rejects a BIK whose publicKey is not a 32-byte key", async () => {
    const { socket, botRuntimeService } = setup()
    const ack = mock((_r: BotHelloResponse) => {})

    await socket.trigger(
      "bot:hello",
      { ...VALID_HELLO, publicKey: Buffer.alloc(16).toString("base64"), publicKeyId: "bik_short" },
      ack
    )

    expect(ack.mock.calls[0]?.[0]).toMatchObject({ ok: false, error: "Invalid bot:hello payload" })
    expect((botRuntimeService.upsertPresenceFromBotKey as ReturnType<typeof mock>).mock.calls.length).toBe(0)
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

describe("bot:invocation:steps", () => {
  const VALID_STEPS = {
    invocationId: "binv_1",
    instanceId: "inst_42",
    claimToken: "tok_1",
    steps: [{ stepType: "thinking", content: "Considering the plan" }],
    statusText: "Thinking…",
  }

  it("persists batched steps through the shared write ops and acks the result", async () => {
    const { socket, botRuntimeWriteOps } = setup({
      recordSteps: async () => ({
        invocationId: "binv_1",
        sessionId: "binv_1",
        steps: [{ stepId: "step_1", stepNumber: 1 }],
      }),
    })
    const ack = mock((_r: BotWriteAck) => {})

    await socket.trigger("bot:invocation:steps", VALID_STEPS, ack)

    // Same persistence path the REST handler calls (INV-35): the frame is handed
    // straight to recordSteps with its steps array intact.
    const call = (botRuntimeWriteOps.recordSteps as ReturnType<typeof mock>).mock.calls[0]?.[0]
    expect(call).toMatchObject({
      workspaceId: "ws_1",
      botId: "bot_alice",
      invocationId: "binv_1",
      claimToken: "tok_1",
      steps: [{ stepType: "thinking", content: "Considering the plan" }],
    })
    const resp = ack.mock.calls[0]?.[0] as BotWriteAck & { ok: true }
    expect(resp.ok).toBe(true)
    expect(resp.data).toEqual({
      invocationId: "binv_1",
      sessionId: "binv_1",
      steps: [{ stepId: "step_1", stepNumber: 1 }],
    })
  })

  it("rejects a malformed frame without touching the write ops", async () => {
    const { socket, botRuntimeWriteOps } = setup()
    const ack = mock((_r: BotWriteAck) => {})

    await socket.trigger("bot:invocation:steps", { invocationId: "binv_1", steps: [] }, ack)

    const resp = ack.mock.calls[0]?.[0] as BotWriteAck
    expect(resp).toEqual({ ok: false, code: "INVALID_PAYLOAD", message: "Invalid bot:invocation:steps payload" })
    expect((botRuntimeWriteOps.recordSteps as ReturnType<typeof mock>).mock.calls.length).toBe(0)
  })

  it("maps an HttpError from the write ops to a terminal ack code", async () => {
    const { socket } = setup({
      recordSteps: async () => {
        throw new HttpError("Invocation claim not found", { status: 404, code: "NOT_FOUND" })
      },
    })
    const ack = mock((_r: BotWriteAck) => {})

    await socket.trigger("bot:invocation:steps", VALID_STEPS, ack)

    expect(ack.mock.calls[0]?.[0]).toEqual({
      ok: false,
      code: "NOT_FOUND",
      message: "Invocation claim not found",
    })
  })
})

describe("bot:invocation:renew", () => {
  it("renews the claim and acks the new expiry", async () => {
    const { socket, botRuntimeWriteOps } = setup({
      renewClaim: async () => ({
        invocationId: "binv_1",
        status: "claimed",
        claimExpiresAt: "2026-05-26T12:02:00.000Z",
      }),
    })
    const ack = mock((_r: BotWriteAck) => {})

    await socket.trigger(
      "bot:invocation:renew",
      { invocationId: "binv_1", instanceId: "inst_42", claimToken: "tok_1" },
      ack
    )

    expect((botRuntimeWriteOps.renewClaim as ReturnType<typeof mock>).mock.calls[0]?.[0]).toMatchObject({
      workspaceId: "ws_1",
      botId: "bot_alice",
      invocationId: "binv_1",
      claimToken: "tok_1",
      claimTtlSeconds: 60,
    })
    const resp = ack.mock.calls[0]?.[0] as BotWriteAck & { ok: true }
    expect(resp.ok).toBe(true)
    expect(resp.data).toEqual({ invocationId: "binv_1", status: "claimed", claimExpiresAt: "2026-05-26T12:02:00.000Z" })
  })

  it("acks a 404 as a terminal NOT_FOUND so the client drops the claim", async () => {
    const { socket } = setup({
      renewClaim: async () => {
        throw new HttpError("Invocation claim not found", { status: 404, code: "NOT_FOUND" })
      },
    })
    const ack = mock((_r: BotWriteAck) => {})

    await socket.trigger(
      "bot:invocation:renew",
      { invocationId: "binv_gone", instanceId: "inst_42", claimToken: "tok_1" },
      ack
    )

    expect(ack.mock.calls[0]?.[0]).toMatchObject({ ok: false, code: "NOT_FOUND" })
  })
})

describe("bot:presence:update", () => {
  it("applies presence through the shared write ops and acks ok", async () => {
    const { socket, botRuntimeWriteOps } = setup()
    const ack = mock((_r: BotWriteAck) => {})

    await socket.trigger(
      "bot:presence:update",
      { runtimeKind: "pi-local", instanceId: "inst_42", status: "busy", acceptingInvocations: false },
      ack
    )

    expect((botRuntimeWriteOps.applyPresence as ReturnType<typeof mock>).mock.calls[0]?.[0]).toMatchObject({
      workspaceId: "ws_1",
      botId: "bot_alice",
      instanceId: "inst_42",
      status: "busy",
      acceptingInvocations: false,
      manifest: null,
    })
    expect(ack.mock.calls[0]?.[0]).toEqual({ ok: true })
  })

  it("rejects a malformed presence frame", async () => {
    const { socket, botRuntimeWriteOps } = setup()
    const ack = mock((_r: BotWriteAck) => {})

    await socket.trigger("bot:presence:update", { instanceId: "inst_42" }, ack)

    expect(ack.mock.calls[0]?.[0]).toMatchObject({ ok: false, code: "INVALID_PAYLOAD" })
    expect((botRuntimeWriteOps.applyPresence as ReturnType<typeof mock>).mock.calls.length).toBe(0)
  })
})
