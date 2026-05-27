/**
 * E2E test for the bot-runtime `/bot` Socket.IO namespace.
 *
 * Boots a real Socket.IO connection against the running backend, exercises the
 * hello handshake, asserts a live push lands on the wire, and verifies that
 * reconnecting with a `sinceCursor` replays invocations that were dispatched
 * while the socket was down. This is the transport-level coverage the
 * unit-level handler tests can't give us — they all mock the namespace.
 */

import { describe, test, expect, setDefaultTimeout } from "bun:test"
import { BotInvocationCapabilities, BotTraits, WORKSPACE_PERMISSION_SCOPES } from "@threa/types"
import { io, type Socket } from "socket.io-client"
import { TestClient, loginAs, createWorkspace, createBot, createBotKey, botApiPost, dispatchCommand } from "../client"

setDefaultTimeout(60_000)

const testRunId = Math.random().toString(36).substring(7)
const testEmail = (name: string) => `${name}-${testRunId}@test.com`

function getBaseUrl(): string {
  return process.env.TEST_BASE_URL || "http://localhost:3001"
}

interface LinkedPi {
  apiKey: string
  streamId: string
  instanceId: string
  runtimeSessionId: string
}

async function createLinkedPi(client: TestClient, workspaceId: string, suffix: string): Promise<LinkedPi> {
  const bot = await createBot(client, workspaceId, {
    type: "personal",
    name: `Pi ${suffix}`,
    slug: `pi-${suffix}`,
    traits: [BotTraits.ACTIVE_SCRATCHPAD, BotTraits.MENTIONABLE],
  })
  const apiKey = await createBotKey(client, workspaceId, bot.id, [
    WORKSPACE_PERMISSION_SCOPES.BOT_RUNTIME_WRITE,
    WORKSPACE_PERMISSION_SCOPES.BOT_INVOCATIONS_WRITE,
  ])
  const instanceId = `inst-${suffix}`
  const runtimeSessionId = `sess-${suffix}`

  const session = await botApiPost<{
    data: { activeStreamId: string; runtimeSessionId: string }
  }>(client, workspaceId, "/bot-runtime/sessions", apiKey, {
    runtimeKind: "pi-local",
    instanceId,
    runtimeSessionId,
    displayName: `Pi ${suffix}`,
    localCwd: "/tmp/threa-test",
  })
  if (session.status !== 200) throw new Error(`Session create failed: ${JSON.stringify(session.data)}`)

  const presence = await botApiPost(client, workspaceId, "/bot-runtime/presence", apiKey, {
    runtimeKind: "pi-local",
    instanceId,
    runtimeSessionId,
    displayName: `Pi ${suffix}`,
    status: "available",
    acceptingInvocations: true,
    capabilities: {
      runtimeSessionId,
      supportsActiveScratchpad: true,
      supportsPersistentSessions: true,
      supportsSessionControlCommands: true,
      sessionControlCommands: ["compact", "model", "thinking", "skill", "reload"],
      thinkingLevels: ["off", "minimal", "low", "medium", "high"],
    },
  })
  if (presence.status !== 200) throw new Error(`Presence failed: ${JSON.stringify(presence.data)}`)

  return { apiKey, streamId: session.data.data.activeStreamId, instanceId, runtimeSessionId }
}

function openBotSocket(apiKey: string): Socket {
  return io(`${getBaseUrl()}/bot`, {
    auth: { token: apiKey },
    transports: ["websocket"],
    autoConnect: false,
    reconnection: false,
  })
}

function connect(socket: Socket, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("connect timeout")), timeoutMs)
    socket.once("connect", () => {
      clearTimeout(t)
      resolve()
    })
    socket.once("connect_error", (err) => {
      clearTimeout(t)
      reject(err)
    })
    socket.connect()
  })
}

interface HelloAck {
  ok: boolean
  error?: string
  serverGeneratedAt?: string
  availableInvocations?: Array<{ id: string; requiredCapability?: string }>
  ownedClaims?: Array<{ id: string }>
}

function sendHello(
  socket: Socket,
  params: { instanceId: string; runtimeSessionId: string; sinceCursor?: string },
  timeoutMs = 10_000
): Promise<HelloAck> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("hello ack timeout")), timeoutMs)
    socket.emit(
      "bot:hello",
      {
        instanceId: params.instanceId,
        runtimeKind: "pi-local",
        runtimeSessionId: params.runtimeSessionId,
        supportedCapabilities: [
          BotInvocationCapabilities.ACTIVE_SCRATCHPAD,
          BotInvocationCapabilities.MENTIONABLE,
          BotInvocationCapabilities.SESSION_CONTROL,
        ],
        ...(params.sinceCursor ? { sinceCursor: params.sinceCursor } : {}),
      },
      (ack: HelloAck) => {
        clearTimeout(t)
        if (!ack) reject(new Error("missing ack"))
        else resolve(ack)
      }
    )
  })
}

interface AvailablePayload {
  invocationId: string
  targetRuntimeSessionId: string | null
  createdAt: string
}

function waitForAvailable(socket: Socket, runtimeSessionId: string, timeoutMs = 15_000): Promise<AvailablePayload> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      socket.off("bot_invocation:available", handler)
      reject(new Error("bot_invocation:available timeout"))
    }, timeoutMs)
    const handler = (payload: AvailablePayload) => {
      if (payload?.targetRuntimeSessionId === runtimeSessionId) {
        clearTimeout(t)
        socket.off("bot_invocation:available", handler)
        resolve(payload)
      }
    }
    socket.on("bot_invocation:available", handler)
  })
}

describe("bot-runtime /bot WebSocket transport (e2e)", () => {
  test("hello → live push: dispatch after hello surfaces via bot_invocation:available", async () => {
    const client = new TestClient()
    await loginAs(client, testEmail("ws-push"), "WS Push User")
    const workspace = await createWorkspace(client, `WS Push WS ${testRunId}`)
    const linked = await createLinkedPi(client, workspace.id, `push-${testRunId}`)

    const socket = openBotSocket(linked.apiKey)
    try {
      await connect(socket)
      const ack = await sendHello(socket, { instanceId: linked.instanceId, runtimeSessionId: linked.runtimeSessionId })
      expect(ack.ok).toBe(true)
      expect(typeof ack.serverGeneratedAt).toBe("string")

      const pushPromise = waitForAvailable(socket, linked.runtimeSessionId)
      const dispatched = await dispatchCommand(client, workspace.id, linked.streamId, "/thinking high")
      expect(dispatched.success).toBe(true)

      const push = await pushPromise
      expect(push.targetRuntimeSessionId).toBe(linked.runtimeSessionId)
      expect(typeof push.invocationId).toBe("string")
      expect(push.invocationId.length).toBeGreaterThan(0)
    } finally {
      socket.removeAllListeners()
      socket.disconnect()
    }
  })

  test("reconnect with sinceCursor replays invocations dispatched while the socket was down", async () => {
    const client = new TestClient()
    await loginAs(client, testEmail("ws-replay"), "WS Replay User")
    const workspace = await createWorkspace(client, `WS Replay WS ${testRunId}`)
    const linked = await createLinkedPi(client, workspace.id, `replay-${testRunId}`)

    // First connection: hello, capture cursor, disconnect.
    const first = openBotSocket(linked.apiKey)
    let cursor: string
    try {
      await connect(first)
      const ack = await sendHello(first, { instanceId: linked.instanceId, runtimeSessionId: linked.runtimeSessionId })
      expect(ack.ok).toBe(true)
      expect(typeof ack.serverGeneratedAt).toBe("string")
      cursor = ack.serverGeneratedAt!
    } finally {
      first.removeAllListeners()
      first.disconnect()
    }

    // Socket is closed. Dispatch a command — push has nowhere to land,
    // so the only way the next connection learns about it is the hello replay.
    const dispatched = await dispatchCommand(client, workspace.id, linked.streamId, "/thinking high")
    expect(dispatched.success).toBe(true)

    // Reconnect with the captured cursor. Replay must surface the invocation
    // in availableInvocations (or ownedClaims if it got claimed in between).
    const second = openBotSocket(linked.apiKey)
    try {
      await connect(second)
      const ack = await sendHello(second, {
        instanceId: linked.instanceId,
        runtimeSessionId: linked.runtimeSessionId,
        sinceCursor: cursor,
      })
      expect(ack.ok).toBe(true)
      const surfaced = (ack.availableInvocations?.length ?? 0) > 0 || (ack.ownedClaims?.length ?? 0) > 0
      expect(surfaced).toBe(true)
    } finally {
      second.removeAllListeners()
      second.disconnect()
    }
  })
})
