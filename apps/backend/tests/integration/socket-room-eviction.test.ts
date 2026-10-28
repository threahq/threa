import { afterAll, beforeAll, describe, test, expect } from "bun:test"
import { Pool } from "pg"
import type { Socket } from "socket.io-client"
import * as Y from "yjs"
import type { Stream } from "@threahq/types"
import { decodeUpdateBase64, encodeUpdateBase64, writeContentJson, ydocToContentJson } from "../../src/features/docs"
import { WorkspaceAuthzService } from "../../src/features/workspace-authz"
import { UserRepository, WorkspaceService, type AvatarService } from "../../src/features/workspaces"
import { blockId } from "../../src/lib/id"
import type { QueueManager } from "../../src/lib/queue"
import { getTestIo } from "../setup"
import { getTestDatabaseTarget } from "../test-database"
import {
  TestClient,
  addStreamMember,
  connectSocket,
  createChannel,
  createSocket,
  createThread,
  createWorkspace,
  deleteMessage,
  joinAck,
  joinWorkspace,
  loginAs,
  removeStreamMember,
  sendMessage,
  updateMessage,
  updateStream,
} from "../client"

const testRunId = Math.random().toString(36).slice(2, 8)
const roomOf = (workspaceId: string, streamId: string) => `ws:${workspaceId}:stream:${streamId}`

/** Resolves once the server has written every frame it sent this socket before the ping. */
function serverHasProcessed(socket: Socket): Promise<void> {
  return new Promise((resolve) => socket.emit("health:ping", () => resolve()))
}

function nextEvent(socket: Socket, eventType: string): Promise<void> {
  return new Promise((resolve) => socket.once(eventType, () => resolve()))
}

function record(socket: Socket, eventTypes: string[]): string[] {
  const seen: string[] = []
  for (const eventType of eventTypes) socket.on(eventType, () => seen.push(eventType))
  return seen
}

async function setup(label: string) {
  const owner = new TestClient()
  await loginAs(owner, `evict-${label}-owner-${testRunId}@test.com`, "Evict Owner")
  const ws = await createWorkspace(owner, `Evict ${label}`)
  const other = new TestClient()
  await loginAs(other, `evict-${label}-other-${testRunId}@test.com`, "Evict Other")
  const otherUser = await joinWorkspace(other, ws.id)
  const ownerSocket = createSocket(owner)
  const otherSocket = createSocket(other)
  await Promise.all([connectSocket(ownerSocket), connectSocket(otherSocket)])
  // As the app does on open: the workspace room seats each socket in its user room too.
  expect({
    owner: await joinAck(ownerSocket, `ws:${ws.id}`),
    other: await joinAck(otherSocket, `ws:${ws.id}`),
  }).toEqual({ owner: { ok: true }, other: { ok: true } })
  return { owner, other, otherUser, workspaceId: ws.id, ownerSocket, otherSocket }
}

/**
 * Sends a message after the revocation. Outbox events broadcast in order and each
 * eviction finishes before the next event, so once the owner holds the message, a socket
 * still seated in the room would hold it too.
 */
async function ownerSends(ownerSocket: Socket, otherSocket: Socket, send: () => Promise<unknown>, eventType: string) {
  const ownerSaw = nextEvent(ownerSocket, eventType)
  await send()
  await ownerSaw
  await serverHasProcessed(otherSocket)
}

describe("socket room eviction on lost access", () => {
  let pool: Pool

  async function demoteToGuest(workspaceId: string, userId: string) {
    const user = await UserRepository.findById(pool, workspaceId, userId)
    await new WorkspaceAuthzService({ pool }).applyMembershipChange({
      workspaceId,
      workosUserId: user!.workosUserId!,
      roleSlugs: ["guest"],
      status: "active",
      lastEventAt: new Date(),
    })
  }
  beforeAll(() => {
    pool = new Pool({ connectionString: getTestDatabaseTarget().connectionUrl })
  })
  afterAll(async () => {
    await pool.end()
  })

  test("should stop delivering a private channel and its thread to a member once removed", async () => {
    const { owner, otherUser, workspaceId, ownerSocket, otherSocket } = await setup("member")
    try {
      const channel = await createChannel(owner, workspaceId, `evict-member-${testRunId}`, "private")
      expect((await addStreamMember(owner, workspaceId, channel.id, otherUser.id)).status).toBe(201)
      const anchor = await sendMessage(owner, workspaceId, channel.id, "anchor")
      const thread = await createThread(owner, workspaceId, channel.id, anchor.id)
      for (const streamId of [channel.id, thread.id]) {
        expect({
          owner: await joinAck(ownerSocket, roomOf(workspaceId, streamId)),
          other: await joinAck(otherSocket, roomOf(workspaceId, streamId)),
        }).toEqual({ owner: { ok: true }, other: { ok: true } })
      }

      expect((await removeStreamMember(owner, workspaceId, channel.id, otherUser.id)).status).toBe(204)
      const seen = record(otherSocket, ["message:created"])
      await ownerSends(
        ownerSocket,
        otherSocket,
        () => sendMessage(owner, workspaceId, channel.id, "after"),
        "message:created"
      )
      await ownerSends(
        ownerSocket,
        otherSocket,
        () => sendMessage(owner, workspaceId, thread.id, "after"),
        "message:created"
      )

      expect(seen).toEqual([])
    } finally {
      ownerSocket.disconnect()
      otherSocket.disconnect()
    }
  })

  test("should stop delivering a channel to a non-member reader once it turns private", async () => {
    const { owner, workspaceId, ownerSocket, otherSocket } = await setup("visibility")
    try {
      const channel = await createChannel(owner, workspaceId, `evict-visibility-${testRunId}`, "public")
      expect({
        owner: await joinAck(ownerSocket, roomOf(workspaceId, channel.id)),
        other: await joinAck(otherSocket, roomOf(workspaceId, channel.id)),
      }).toEqual({ owner: { ok: true }, other: { ok: true } })
      const before = record(otherSocket, ["message:created"])
      await ownerSends(
        ownerSocket,
        otherSocket,
        () => sendMessage(owner, workspaceId, channel.id, "before"),
        "message:created"
      )
      expect(before).toEqual(["message:created"])

      expect((await updateStream(owner, workspaceId, channel.id, { visibility: "private" })).status).toBe(200)
      const after = record(otherSocket, ["message:created"])
      await ownerSends(
        ownerSocket,
        otherSocket,
        () => sendMessage(owner, workspaceId, channel.id, "after"),
        "message:created"
      )

      expect(after).toEqual([])
    } finally {
      ownerSocket.disconnect()
      otherSocket.disconnect()
    }
  })

  test("should stop delivering everything in the workspace to a user removed from it", async () => {
    const { owner, otherUser, workspaceId, ownerSocket, otherSocket } = await setup("workspace")
    try {
      const channel = await createChannel(owner, workspaceId, `evict-workspace-${testRunId}`, "public")
      expect({
        owner: await joinAck(ownerSocket, roomOf(workspaceId, channel.id)),
        other: await joinAck(otherSocket, roomOf(workspaceId, channel.id)),
      }).toEqual({ owner: { ok: true }, other: { ok: true } })

      // The HTTP route removes through the control plane, which the test server has none of.
      await new WorkspaceService(pool, {} as AvatarService, {} as QueueManager).removeUser(workspaceId, otherUser.id)
      const seen = record(otherSocket, ["message:created", "stream:created"])
      await ownerSends(
        ownerSocket,
        otherSocket,
        () => sendMessage(owner, workspaceId, channel.id, "after"),
        "message:created"
      )
      await ownerSends(
        ownerSocket,
        otherSocket,
        () => createChannel(owner, workspaceId, `evict-workspace-new-${testRunId}`, "public"),
        "stream:created"
      )

      expect(seen).toEqual([])
    } finally {
      ownerSocket.disconnect()
      otherSocket.disconnect()
    }
  })

  test("should stop delivering a session's trace to a member removed from its channel", async () => {
    const { owner, otherUser, workspaceId, ownerSocket, otherSocket } = await setup("session")
    try {
      const channel = await createChannel(owner, workspaceId, `evict-session-${testRunId}`, "private")
      expect((await addStreamMember(owner, workspaceId, channel.id, otherUser.id)).status).toBe(201)
      const sessionId = `agsess_evict_${testRunId}`
      await pool.query(
        `INSERT INTO agent_sessions (id, workspace_id, stream_id, persona_id, trigger_message_id, status)
         VALUES ($1, $2, $3, 'persona_evict', 'msg_evict', 'running')`,
        [sessionId, workspaceId, channel.id]
      )
      const sessionRoom = `ws:${workspaceId}:agent_session:${sessionId}`
      expect({
        channel: await joinAck(ownerSocket, roomOf(workspaceId, channel.id)),
        owner: await joinAck(ownerSocket, sessionRoom),
        other: await joinAck(otherSocket, sessionRoom),
      }).toEqual({ channel: { ok: true }, owner: { ok: true }, other: { ok: true } })

      expect((await removeStreamMember(owner, workspaceId, channel.id, otherUser.id)).status).toBe(204)
      // The removal's own broadcast reaches the member; once it has, its eviction has run.
      await ownerSends(
        ownerSocket,
        otherSocket,
        () => sendMessage(owner, workspaceId, channel.id, "after"),
        "message:created"
      )
      const seen = record(otherSocket, ["agent_session:substep"])
      await ownerSends(
        ownerSocket,
        otherSocket,
        async () => getTestIo().to(sessionRoom).emit("agent_session:substep", { sessionId }),
        "agent_session:substep"
      )

      expect(seen).toEqual([])
    } finally {
      ownerSocket.disconnect()
      otherSocket.disconnect()
    }
  })

  test("should stop delivering a channel to a guest once it narrows from guest_public to public", async () => {
    const { owner, otherUser, workspaceId, ownerSocket, otherSocket } = await setup("guest-public")
    try {
      const channel = await createChannel(owner, workspaceId, `evict-guest-public-${testRunId}`, "guest_public")
      await demoteToGuest(workspaceId, otherUser.id)
      expect({
        owner: await joinAck(ownerSocket, roomOf(workspaceId, channel.id)),
        other: await joinAck(otherSocket, roomOf(workspaceId, channel.id)),
      }).toEqual({ owner: { ok: true }, other: { ok: true } })
      const before = record(otherSocket, ["message:created"])
      await ownerSends(
        ownerSocket,
        otherSocket,
        () => sendMessage(owner, workspaceId, channel.id, "before"),
        "message:created"
      )
      expect(before).toEqual(["message:created"])

      expect((await updateStream(owner, workspaceId, channel.id, { visibility: "public" })).status).toBe(200)
      const seen = record(otherSocket, ["message:created"])
      await ownerSends(
        ownerSocket,
        otherSocket,
        () => sendMessage(owner, workspaceId, channel.id, "after"),
        "message:created"
      )

      expect(seen).toEqual([])
    } finally {
      ownerSocket.disconnect()
      otherSocket.disconnect()
    }
  })

  test("should stop delivering a public channel to a member demoted to guest", async () => {
    const { owner, otherUser, workspaceId, ownerSocket, otherSocket } = await setup("demoted")
    try {
      const channel = await createChannel(owner, workspaceId, `evict-demoted-${testRunId}`, "public")
      expect({
        owner: await joinAck(ownerSocket, roomOf(workspaceId, channel.id)),
        other: await joinAck(otherSocket, roomOf(workspaceId, channel.id)),
      }).toEqual({ owner: { ok: true }, other: { ok: true } })

      await demoteToGuest(workspaceId, otherUser.id)
      const seen = record(otherSocket, ["message:created"])
      await ownerSends(
        ownerSocket,
        otherSocket,
        () => sendMessage(owner, workspaceId, channel.id, "after"),
        "message:created"
      )

      expect(seen).toEqual([])
    } finally {
      ownerSocket.disconnect()
      otherSocket.disconnect()
    }
  })

  test("should stop delivering a moved doc and its section thread to a reader of the old host only", async () => {
    const { owner, otherUser, workspaceId, ownerSocket, otherSocket } = await setup("doc-move")
    try {
      const from = await createChannel(owner, workspaceId, `evict-move-from-${testRunId}`, "private")
      expect((await addStreamMember(owner, workspaceId, from.id, otherUser.id)).status).toBe(201)
      const to = await createChannel(owner, workspaceId, `evict-move-to-${testRunId}`, "private")
      const created = await owner.post<{ stream: Stream }>(`/api/workspaces/${workspaceId}/streams`, {
        type: "doc",
        parentStreamId: from.id,
      })
      expect(created.status).toBe(201)
      const docId = created.data.stream.id
      const loaded = await owner.get<{ state: string }>(`/api/workspaces/${workspaceId}/docs/${docId}`)
      const ydoc = new Y.Doc()
      Y.applyUpdate(ydoc, decodeUpdateBase64(loaded.data.state))
      const block = blockId()
      const update = encodeUpdateBase64(
        writeContentJson(ydoc, {
          type: "doc",
          content: [{ type: "paragraph", attrs: { blockId: block }, content: [{ type: "text", text: "x" }] }],
        })
      )
      expect((await owner.post(`/api/workspaces/${workspaceId}/docs/${docId}/updates`, { update })).status).toBe(200)
      const thread = await createThread(owner, workspaceId, docId, block)
      for (const streamId of [docId, thread.id]) {
        expect({
          owner: await joinAck(ownerSocket, roomOf(workspaceId, streamId)),
          other: await joinAck(otherSocket, roomOf(workspaceId, streamId)),
        }).toEqual({ owner: { ok: true }, other: { ok: true } })
      }

      const moved = await owner.post(`/api/workspaces/${workspaceId}/docs/${docId}/move`, {
        fromStreamId: from.id,
        toStreamId: to.id,
      })
      expect(moved.status).toBe(200)
      const seen = record(otherSocket, ["message:created"])
      await ownerSends(
        ownerSocket,
        otherSocket,
        () => sendMessage(owner, workspaceId, thread.id, "after"),
        "message:created"
      )

      expect(seen).toEqual([])
    } finally {
      ownerSocket.disconnect()
      otherSocket.disconnect()
    }
  })

  describe("a reader whose only access is a share grant", () => {
    async function sharedDoc(label: string, { hostMember = false } = {}) {
      const context = await setup(label)
      const { owner, otherUser, workspaceId, ownerSocket, otherSocket } = context
      const host = await createChannel(owner, workspaceId, `evict-${label}-host-${testRunId}`, "private")
      if (hostMember) expect((await addStreamMember(owner, workspaceId, host.id, otherUser.id)).status).toBe(201)
      const open = await createChannel(owner, workspaceId, `evict-${label}-open-${testRunId}`, "public")
      const created = await owner.post<{ stream: Stream }>(`/api/workspaces/${workspaceId}/streams`, {
        type: "doc",
        parentStreamId: host.id,
      })
      expect(created.status).toBe(201)
      const docId = created.data.stream.id
      const shared = await owner.post<{ message: { id: string } }>(`/api/workspaces/${workspaceId}/messages`, {
        streamId: open.id,
        contentJson: {
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "docEmbed", attrs: { docId, title: "Plan" } }] }],
        },
        confirmedPrivacyWarning: true,
      })
      expect(shared.status).toBe(201)
      expect({
        owner: await joinAck(ownerSocket, roomOf(workspaceId, docId)),
        other: await joinAck(otherSocket, roomOf(workspaceId, docId)),
      }).toEqual({ owner: { ok: true }, other: { ok: true } })

      const appendParagraph = async () => {
        const loaded = await owner.get<{ state: string }>(`/api/workspaces/${workspaceId}/docs/${docId}`)
        const ydoc = new Y.Doc()
        Y.applyUpdate(ydoc, decodeUpdateBase64(loaded.data.state))
        const json = ydocToContentJson(ydoc)
        const block = { type: "paragraph", attrs: { blockId: blockId() }, content: [{ type: "text", text: "x" }] }
        const update = encodeUpdateBase64(
          writeContentJson(ydoc, { ...json, content: [...(json.content ?? []), block] })
        )
        const posted = await owner.post(`/api/workspaces/${workspaceId}/docs/${docId}/updates`, { update })
        expect(posted.status).toBe(200)
      }
      const before = record(otherSocket, ["doc:updated"])
      await ownerSends(ownerSocket, otherSocket, appendParagraph, "doc:updated")
      expect(before).toEqual(["doc:updated"])

      return { ...context, hostId: host.id, shareMessageId: shared.data.message.id, appendParagraph }
    }

    test("should stop delivering the doc once the share message drops its chip", async () => {
      const { owner, workspaceId, ownerSocket, otherSocket, shareMessageId, appendParagraph } = await sharedDoc("edit")
      try {
        await updateMessage(owner, workspaceId, shareMessageId, "no longer shared")
        const seen = record(otherSocket, ["doc:updated"])
        await ownerSends(ownerSocket, otherSocket, appendParagraph, "doc:updated")

        expect(seen).toEqual([])
      } finally {
        ownerSocket.disconnect()
        otherSocket.disconnect()
      }
    })

    test("should keep delivering the doc to a host member removed from the host while the share stands", async () => {
      const { owner, otherUser, workspaceId, ownerSocket, otherSocket, hostId, appendParagraph } = await sharedDoc(
        "host-member",
        { hostMember: true }
      )
      try {
        expect((await removeStreamMember(owner, workspaceId, hostId, otherUser.id)).status).toBe(204)
        const seen = record(otherSocket, ["doc:updated"])
        await ownerSends(ownerSocket, otherSocket, appendParagraph, "doc:updated")

        expect(seen).toEqual(["doc:updated"])
      } finally {
        ownerSocket.disconnect()
        otherSocket.disconnect()
      }
    })

    test("should stop delivering the doc once the share message is deleted", async () => {
      const { owner, workspaceId, ownerSocket, otherSocket, shareMessageId, appendParagraph } =
        await sharedDoc("delete")
      try {
        await deleteMessage(owner, workspaceId, shareMessageId)
        const seen = record(otherSocket, ["doc:updated"])
        await ownerSends(ownerSocket, otherSocket, appendParagraph, "doc:updated")

        expect(seen).toEqual([])
      } finally {
        ownerSocket.disconnect()
        otherSocket.disconnect()
      }
    })
  })
})
