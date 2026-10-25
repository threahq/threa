import { describe, test, expect } from "bun:test"
import { io, Socket } from "socket.io-client"
import type { DocAwarenessPayload, Stream } from "@threahq/types"
import {
  TestClient,
  getBaseUrl,
  loginAs,
  createWorkspace,
  createChannel,
  joinWorkspace,
  addStreamMember,
} from "../client"

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

function healthPing(socket: Socket): Promise<void> {
  return new Promise((resolve) => socket.emit("health:ping", () => resolve()))
}

function collectFrames(socket: Socket) {
  const frames: DocAwarenessPayload[] = []
  const waiters: Array<{ count: number; resolve: () => void }> = []
  socket.on("doc:awareness", (frame: DocAwarenessPayload) => {
    frames.push(frame)
    for (const waiter of waiters.filter((w) => frames.length >= w.count)) waiter.resolve()
  })
  return {
    frames,
    waitFor(count: number): Promise<void> {
      if (frames.length >= count) return Promise.resolve()
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`expected ${count} frames, got ${frames.length}`)), 5000)
        waiters.push({
          count,
          resolve: () => {
            clearTimeout(timeout)
            resolve()
          },
        })
      })
    },
  }
}

const testRunId = Math.random().toString(36).slice(2, 8)

describe("socket doc awareness relay", () => {
  test("should relay a frame to other doc-room sockets only when the sender joined the room and the frame is valid", async () => {
    const owner = new TestClient()
    await loginAs(owner, `awareness-owner-${testRunId}@test.com`, "Awareness Owner")
    const ws = await createWorkspace(owner, "Doc Awareness WS")
    const channel = await createChannel(owner, ws.id, `awareness-${testRunId}`, "private")
    const created = await owner.post<{ stream: Stream }>(`/api/workspaces/${ws.id}/streams`, {
      type: "doc",
      parentStreamId: channel.id,
    })
    expect(created.status).toBe(201)
    const docId = created.data.stream.id

    const member = new TestClient()
    await loginAs(member, `awareness-member-${testRunId}@test.com`, "Awareness Member")
    const memberUser = await joinWorkspace(member, ws.id)
    expect((await addStreamMember(owner, ws.id, channel.id, memberUser.id)).status).toBe(201)

    const outsider = new TestClient()
    await loginAs(outsider, `awareness-outsider-${testRunId}@test.com`, "Awareness Outsider")
    await joinWorkspace(outsider, ws.id)

    const ownerSocket = createSocket(owner)
    const memberSocket = createSocket(member)
    const outsiderSocket = createSocket(outsider)
    try {
      await Promise.all([connectSocket(ownerSocket), connectSocket(memberSocket), connectSocket(outsiderSocket)])
      const room = `ws:${ws.id}:stream:${docId}`
      expect({
        owner: await joinAck(ownerSocket, room),
        member: await joinAck(memberSocket, room),
        outsider: await joinAck(outsiderSocket, room),
      }).toEqual({
        owner: { ok: true },
        member: { ok: true },
        outsider: { ok: false, error: "Not authorized to join this stream" },
      })

      const ownerReceived = collectFrames(ownerSocket)
      const memberReceived = collectFrames(memberSocket)

      const first: DocAwarenessPayload = { workspaceId: ws.id, docId, update: "AQID" }
      ownerSocket.emit("doc:awareness", first)
      await memberReceived.waitFor(1)

      outsiderSocket.emit("doc:awareness", { workspaceId: ws.id, docId, update: "b3V0c2lkZXI=" })
      await healthPing(outsiderSocket)
      ownerSocket.emit("doc:awareness", { workspaceId: ws.id, docId, update: "A".repeat(4097) })
      ownerSocket.emit("doc:awareness", "not-an-object")
      ownerSocket.emit("doc:awareness", { workspaceId: ws.id, docId })

      const second: DocAwarenessPayload = { workspaceId: ws.id, docId, update: "BAUG" }
      ownerSocket.emit("doc:awareness", second)
      await memberReceived.waitFor(2)
      await healthPing(ownerSocket)

      expect({ member: memberReceived.frames, owner: ownerReceived.frames }).toEqual({
        member: [first, second],
        owner: [],
      })
    } finally {
      ownerSocket.disconnect()
      memberSocket.disconnect()
      outsiderSocket.disconnect()
    }
  })
})
