import { describe, test, expect } from "bun:test"
import { io, Socket } from "socket.io-client"
import {
  TestClient,
  loginAs,
  createWorkspace,
  createChannel,
  createThread,
  sendMessage,
  joinWorkspace,
  addStreamMember,
} from "../client"

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

function connectSocket(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.on("connect", () => resolve())
    socket.on("connect_error", reject)
    socket.connect()
  })
}

function joinAck(socket: Socket, room: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Socket join timeout for room: ${room}`)), 5000)
    socket.emit("join", room, (result: { ok: boolean; error?: string }) => {
      clearTimeout(timeout)
      resolve(result)
    })
  })
}

const testRunId = Math.random().toString(36).slice(2, 8)

describe("socket stream joins in one burst", () => {
  test("each room gets its own access decision, including a non-member thread inside a member channel", async () => {
    const owner = new TestClient()
    await loginAs(owner, `batch-owner-${testRunId}@test.com`, "Batch Owner")
    const ws = await createWorkspace(owner, "Batch Join WS")
    const publicChannel = await createChannel(owner, ws.id, `batch-public-${testRunId}`, "public")
    const hiddenChannel = await createChannel(owner, ws.id, `batch-hidden-${testRunId}`, "private")
    const sharedChannel = await createChannel(owner, ws.id, `batch-shared-${testRunId}`, "private")
    const anchor = await sendMessage(owner, ws.id, sharedChannel.id, "thread anchor")
    const thread = await createThread(owner, ws.id, sharedChannel.id, anchor.id)

    const member = new TestClient()
    await loginAs(member, `batch-member-${testRunId}@test.com`, "Batch Member")
    const memberUser = await joinWorkspace(member, ws.id)
    const added = await addStreamMember(owner, ws.id, sharedChannel.id, memberUser.id)
    expect(added.status).toBe(201)

    const socket = createSocket(member)
    await connectSocket(socket)
    try {
      const streamIds = {
        publicChannel: publicChannel.id,
        hiddenChannel: hiddenChannel.id,
        sharedChannel: sharedChannel.id,
        thread: thread.id,
        missing: "stream_does_not_exist",
      }
      const acks = await Promise.all(
        Object.entries(streamIds).map(async ([name, streamId]) => [
          name,
          await joinAck(socket, `ws:${ws.id}:stream:${streamId}`),
        ])
      )

      const denied = { ok: false, error: "Not authorized to join this stream" }
      expect(Object.fromEntries(acks)).toEqual({
        publicChannel: { ok: true },
        hiddenChannel: denied,
        sharedChannel: { ok: true },
        thread: { ok: true },
        missing: denied,
      })

      const delivered = new Promise<{ streamId: string }>((resolve) => socket.once("message:created", resolve))
      await sendMessage(owner, ws.id, thread.id, "reply in thread")
      expect(await delivered).toMatchObject({ streamId: thread.id })
    } finally {
      socket.disconnect()
    }
  })
})
