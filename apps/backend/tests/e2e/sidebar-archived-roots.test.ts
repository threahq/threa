import { describe, test, expect } from "bun:test"
import { io, type Socket } from "socket.io-client"
import {
  TestClient,
  loginAs,
  createWorkspace,
  createScratchpad,
  sendMessage,
  createThread,
  archiveStream,
  getWorkspaceBootstrap,
  getBootstrap,
  joinRoom,
} from "../client"

const testRunId = Math.random().toString(36).substring(7)
const testEmail = (name: string) => `${name}-${testRunId}@test.com`

function getBaseUrl(): string {
  return process.env.TEST_BASE_URL || "http://localhost:3001"
}

function createSocket(client: TestClient): Socket {
  const cookies = (client as unknown as { cookies?: Map<string, string> }).cookies
  return io(getBaseUrl(), {
    extraHeaders: {
      Cookie: cookies
        ? Array.from(cookies.entries())
            .map(([k, v]) => `${k}=${v}`)
            .join("; ")
        : "",
    },
    transports: ["websocket"],
    autoConnect: false,
  })
}

async function connectSocket(socket: Socket, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Socket connection timeout")), timeoutMs)
    socket.on("connect", () => {
      clearTimeout(timeout)
      resolve()
    })
    socket.on("connect_error", (err) => {
      clearTimeout(timeout)
      reject(err)
    })
    socket.connect()
  })
}

function waitForEvent<T = unknown>(socket: Socket, eventName: string, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(eventName, handler)
      reject(new Error(`Timeout waiting for event: ${eventName}`))
    }, timeoutMs)
    const handler = (data: T) => {
      clearTimeout(timeout)
      socket.off(eventName, handler)
      resolve(data)
    }
    socket.on(eventName, handler)
  })
}

/**
 * Archiving a stream marks only that row; its thread descendants stay "active".
 * The workspace bootstrap feeds the sidebar, so a thread whose root
 * scratchpad/channel was archived must be excluded from the bootstrap's stream
 * list — otherwise it surfaces in the sidebar with no signal that its root is
 * archived (the root itself is excluded as archived, so the client can't tell).
 */
describe("Workspace bootstrap excludes threads rooted in archived streams", () => {
  test("omits a thread whose root scratchpad is archived, keeps a thread under an active root", async () => {
    const client = new TestClient()
    await loginAs(client, testEmail("archived-root"), "Archived Root Test")
    const workspace = await createWorkspace(client, `Archived Root WS ${testRunId}`)

    const archivedRoot = await createScratchpad(client, workspace.id, "off")
    const archivedMsg = await sendMessage(client, workspace.id, archivedRoot.id, "parent in soon-archived root")
    const archivedThread = await createThread(client, workspace.id, archivedRoot.id, archivedMsg.id)

    const activeRoot = await createScratchpad(client, workspace.id, "off")
    const activeMsg = await sendMessage(client, workspace.id, activeRoot.id, "parent in active root")
    const activeThread = await createThread(client, workspace.id, activeRoot.id, activeMsg.id)

    await archiveStream(client, workspace.id, archivedRoot.id)

    const bootstrap = await getWorkspaceBootstrap(client, workspace.id)
    const streamIds = new Set(bootstrap.streams.map((s) => s.id))

    // The archived root itself is excluded (active-only bootstrap).
    expect(streamIds.has(archivedRoot.id)).toBe(false)
    // The thread under the archived root is excluded — the fix under test.
    expect(streamIds.has(archivedThread.id)).toBe(false)
    // The active root and its thread still appear.
    expect(streamIds.has(activeRoot.id)).toBe(true)
    expect(streamIds.has(activeThread.id)).toBe(true)
  })

  test("per-stream bootstrap surfaces rootArchivedAt for a thread under an archived root", async () => {
    const client = new TestClient()
    await loginAs(client, testEmail("root-archived-at"), "Root ArchivedAt Test")
    const workspace = await createWorkspace(client, `Root ArchivedAt WS ${testRunId}`)

    const root = await createScratchpad(client, workspace.id, "off")
    const parentMsg = await sendMessage(client, workspace.id, root.id, "parent")
    const thread = await createThread(client, workspace.id, root.id, parentMsg.id)
    await archiveStream(client, workspace.id, root.id)

    const threadBootstrap = await getBootstrap(client, workspace.id, thread.id)
    expect(threadBootstrap.stream.id).toBe(thread.id)
    // The thread is active on its own row; the bootstrap carries the root's
    // archived timestamp so the client can hide the composer without the root
    // being resident in the workspace stream cache.
    expect(threadBootstrap.stream.archivedAt).toBeNull()
    expect(threadBootstrap.rootArchivedAt).not.toBeNull()
  })

  test("sending to a thread under an archived root is rejected with 403", async () => {
    const client = new TestClient()
    await loginAs(client, testEmail("send-block"), "Send Block Test")
    const workspace = await createWorkspace(client, `Send Block WS ${testRunId}`)

    const root = await createScratchpad(client, workspace.id, "off")
    const parentMsg = await sendMessage(client, workspace.id, root.id, "parent")
    const thread = await createThread(client, workspace.id, root.id, parentMsg.id)
    await archiveStream(client, workspace.id, root.id)

    const { status, data } = await client.post(`/api/workspaces/${workspace.id}/messages`, {
      streamId: thread.id,
      content: "reply after archive",
    })
    expect(status).toBe(403)
    expect((data as { error?: string }).error).toBe("Cannot send messages to a thread under an archived stream")
  })

  test("a socket joined only to a thread's room receives the root's stream:archived event", async () => {
    // A thread viewer only joins the thread's stream room, not the root's.
    // The root's archive event must be routed to the thread's room too, or
    // the thread composer stays live until a page refresh (the reported
    // flakiness). This joins ONLY the thread room and asserts the event
    // arrives — isolating the thread-room routing from the root-room path.
    const client = new TestClient()
    await loginAs(client, testEmail("live-routing"), "Live Routing Test")
    const workspace = await createWorkspace(client, `Live Routing WS ${testRunId}`)

    const root = await createScratchpad(client, workspace.id, "off")
    const parentMsg = await sendMessage(client, workspace.id, root.id, "parent")
    const thread = await createThread(client, workspace.id, root.id, parentMsg.id)

    const socket = createSocket(client)
    try {
      await connectSocket(socket)
      // Join ONLY the thread's room — explicitly not the root's.
      await joinRoom(socket, `ws:${workspace.id}:stream:${thread.id}`)

      const eventPromise = waitForEvent<{ streamId: string }>(socket, "stream:archived")
      await archiveStream(client, workspace.id, root.id)
      const event = await eventPromise

      expect(event.streamId).toBe(root.id)
    } finally {
      socket.disconnect()
    }
  })

  test("stream:archived delivers the timeline event row live to the root room", async () => {
    // First-class treatment: the outbox payload carries the event row, so a
    // client in the root stream room receives it as a live timeline append
    // (like member_joined) — not just a stream-cache mutation that only
    // surfaces on the next bootstrap. The event row has a sequence and
    // broadcast slot, so it lands in the right timeline position.
    const client = new TestClient()
    await loginAs(client, testEmail("live-event-row"), "Live Event Row Test")
    const workspace = await createWorkspace(client, `Live Event Row WS ${testRunId}`)

    const root = await createScratchpad(client, workspace.id, "off")
    await sendMessage(client, workspace.id, root.id, "a message before archive")

    const socket = createSocket(client)
    try {
      await connectSocket(socket)
      await joinRoom(socket, `ws:${workspace.id}:stream:${root.id}`)

      const eventPromise = waitForEvent<{
        streamId: string
        event: { id: string; eventType: string; sequence: string }
      }>(socket, "stream:archived")
      await archiveStream(client, workspace.id, root.id)
      const payload = await eventPromise

      expect(payload.streamId).toBe(root.id)
      // The event row is in the payload — first-class live append.
      expect(payload.event).toBeDefined()
      expect(payload.event.eventType).toBe("stream_archived")
      expect(BigInt(payload.event.sequence)).toBeGreaterThan(0n)
    } finally {
      socket.disconnect()
    }
  })
})
