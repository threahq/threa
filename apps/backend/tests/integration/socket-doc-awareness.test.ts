import { describe, test, expect } from "bun:test"
import type { Socket } from "socket.io-client"
import { DOC_AWARENESS_MAX_UPDATE_CHARS, type DocAwarenessPayload, type Stream } from "@threahq/types"
import { DOC_AWARENESS_RATE_BURST } from "../../src/features/docs/config"
import {
  TestClient,
  connectSocket,
  createSocket,
  joinAck,
  loginAs,
  createWorkspace,
  createChannel,
  joinWorkspace,
  addStreamMember,
} from "../client"

/** Resolves once the server has handled every frame this socket emitted before it. */
function serverHasProcessed(socket: Socket): Promise<void> {
  return new Promise((resolve) => socket.emit("health:ping", () => resolve()))
}

function collectFrames(socket: Socket) {
  const frames: DocAwarenessPayload[] = []
  const waiters: Array<{ done: (frames: DocAwarenessPayload[]) => boolean; resolve: () => void }> = []
  socket.on("doc:awareness", (frame: DocAwarenessPayload) => {
    frames.push(frame)
    for (const waiter of waiters.filter((w) => w.done(frames))) waiter.resolve()
  })
  const waitUntil = (done: (frames: DocAwarenessPayload[]) => boolean): Promise<void> => {
    if (done(frames)) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`frames never matched, got ${frames.length}`)), 5000)
      waiters.push({
        done,
        resolve: () => {
          clearTimeout(timeout)
          resolve()
        },
      })
    })
  }
  return {
    frames,
    waitUntil,
    waitFor: (count: number) => waitUntil((received) => received.length >= count),
  }
}

const testRunId = Math.random().toString(36).slice(2, 8)

async function createDocRoom(label: string) {
  const owner = new TestClient()
  await loginAs(owner, `awareness-${label}-owner-${testRunId}@test.com`, "Awareness Owner")
  const ws = await createWorkspace(owner, "Doc Awareness WS")
  const channel = await createChannel(owner, ws.id, `awareness-${label}-${testRunId}`, "private")
  const created = await owner.post<{ stream: Stream }>(`/api/workspaces/${ws.id}/streams`, {
    type: "doc",
    parentStreamId: channel.id,
  })
  expect(created.status).toBe(201)
  const docId = created.data.stream.id

  const member = new TestClient()
  await loginAs(member, `awareness-${label}-member-${testRunId}@test.com`, "Awareness Member")
  const memberUser = await joinWorkspace(member, ws.id)
  expect((await addStreamMember(owner, ws.id, channel.id, memberUser.id)).status).toBe(201)

  return { owner, member, workspaceId: ws.id, docId, room: `ws:${ws.id}:stream:${docId}` }
}

describe("socket doc awareness relay", () => {
  test("should relay a frame to other doc-room sockets only when the sender joined the room and the frame is valid", async () => {
    const { owner, member, workspaceId, docId, room } = await createDocRoom("relay")
    const outsider = new TestClient()
    await loginAs(outsider, `awareness-outsider-${testRunId}@test.com`, "Awareness Outsider")
    await joinWorkspace(outsider, workspaceId)

    const ownerSocket = createSocket(owner)
    const memberSocket = createSocket(member)
    const outsiderSocket = createSocket(outsider)
    try {
      await Promise.all([connectSocket(ownerSocket), connectSocket(memberSocket), connectSocket(outsiderSocket)])
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

      const first: DocAwarenessPayload = { workspaceId, docId, update: "AQID" }
      ownerSocket.emit("doc:awareness", first)
      await memberReceived.waitFor(1)

      outsiderSocket.emit("doc:awareness", { workspaceId, docId, update: "b3V0c2lkZXI=" })
      await serverHasProcessed(outsiderSocket)
      ownerSocket.emit("doc:awareness", { workspaceId, docId, update: "A".repeat(DOC_AWARENESS_MAX_UPDATE_CHARS + 1) })
      ownerSocket.emit("doc:awareness", "not-an-object")
      ownerSocket.emit("doc:awareness", { workspaceId, docId })

      const second: DocAwarenessPayload = { workspaceId, docId, update: "BAUG" }
      ownerSocket.emit("doc:awareness", second)
      await memberReceived.waitFor(2)
      await serverHasProcessed(ownerSocket)

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

  test("should drop frames over the per-socket budget", async () => {
    const { owner, member, workspaceId, docId, room } = await createDocRoom("budget")
    const ownerSocket = createSocket(owner)
    const ownerSecondTab = createSocket(owner)
    const memberSocket = createSocket(member)
    try {
      await Promise.all([connectSocket(ownerSocket), connectSocket(ownerSecondTab), connectSocket(memberSocket)])
      expect({
        owner: await joinAck(ownerSocket, room),
        ownerSecondTab: await joinAck(ownerSecondTab, room),
        member: await joinAck(memberSocket, room),
      }).toEqual({ owner: { ok: true }, ownerSecondTab: { ok: true }, member: { ok: true } })
      const memberReceived = collectFrames(memberSocket)
      const sentinel: DocAwarenessPayload = { workspaceId, docId, update: "c2VudGluZWw=" }

      const sent = DOC_AWARENESS_RATE_BURST + 20
      for (let i = 0; i < sent; i++) ownerSocket.emit("doc:awareness", { workspaceId, docId, update: "AQID" })
      await memberReceived.waitFor(DOC_AWARENESS_RATE_BURST)
      await serverHasProcessed(ownerSocket)
      // The Postgres adapter delivers each relay after its own publish, so a later frame from a socket with a fresh budget marks the end of the burst.
      ownerSecondTab.emit("doc:awareness", sentinel)
      await memberReceived.waitUntil((frames) => frames.some((frame) => frame.update === sentinel.update))

      expect(memberReceived.frames.filter((frame) => frame.update !== sentinel.update).length).toBeLessThan(sent)
    } finally {
      ownerSocket.disconnect()
      ownerSecondTab.disconnect()
      memberSocket.disconnect()
    }
  })
})
