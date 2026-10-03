import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { AuthorTypes, StreamTypes, Visibilities } from "@threahq/types"
import { setupTestDatabase, testMessageContent } from "./setup"
import { AttachmentRepository } from "../../src/features/attachments"
import { MessageRepository } from "../../src/features/messaging"
import { StreamEventRepository, StreamRepository } from "../../src/features/streams"
import { UserRepository } from "../../src/features/workspaces"
import { attachmentId, eventId, messageId, streamId, userId, workspaceId } from "../../src/lib/id"

const CLIENT_MESSAGE_ID = "client-message-1"

/**
 * Threa Connect copies rows into a partner workspace under the same ids, so the
 * six copied tables must let workspace A and workspace B each hold a row for
 * one id and read back only their own.
 */
describe("same-id copies across workspaces", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  interface Ids {
    stream: string
    thread: string
    event: string
    message: string
    attachment: string
    user: string
  }

  async function seedWorkspace(ws: string, ids: Ids, label: "a" | "b") {
    await StreamRepository.insert(pool, {
      id: ids.stream,
      workspaceId: ws,
      type: StreamTypes.CHANNEL,
      displayName: `stream ${label}`,
      createdBy: ids.user,
    })
    await StreamRepository.insertThreadOrFind(pool, {
      id: ids.thread,
      workspaceId: ws,
      type: StreamTypes.THREAD,
      visibility: Visibilities.PRIVATE,
      displayName: `thread ${label}`,
      parentStreamId: ids.stream,
      parentAnchorId: ids.message,
      rootStreamId: ids.stream,
      createdBy: ids.user,
    })
    await UserRepository.insert(pool, {
      id: ids.user,
      workspaceId: ws,
      workosUserId: null,
      email: null,
      name: `user ${label}`,
      role: "member",
      slug: `member-${label}`,
    })
    await MessageRepository.insert(pool, {
      id: ids.message,
      workspaceId: ws,
      streamId: ids.stream,
      sequence: 1n,
      authorId: ids.user,
      authorType: AuthorTypes.USER,
      clientMessageId: CLIENT_MESSAGE_ID,
      ...testMessageContent(`message ${label}`),
    })
    await MessageRepository.addReaction(pool, ws, ids.message, "👍", ids.user)
    await AttachmentRepository.insert(pool, {
      id: ids.attachment,
      workspaceId: ws,
      streamId: ids.stream,
      uploadedBy: ids.user,
      filename: `file-${label}.png`,
      mimeType: "image/png",
      sizeBytes: 1,
      storagePath: `${ws}/${ids.attachment}`,
    })
  }

  async function seedPair() {
    const wsA = workspaceId()
    const wsB = workspaceId()
    const ids: Ids = {
      stream: streamId(),
      thread: streamId(),
      event: eventId(),
      message: messageId(),
      attachment: attachmentId(),
      user: userId(),
    }
    await seedWorkspace(wsA, ids, "a")
    await StreamEventRepository.insert(pool, {
      id: ids.event,
      workspaceId: wsA,
      streamId: ids.stream,
      eventType: "message_created",
      payload: { messageId: ids.message, origin: "a" },
    })
    await seedWorkspace(wsB, ids, "b")
    // stream_sequences keeps its single-column key until the follow-up contract, so the allocating insert cannot run for a second workspace.
    await pool.query(
      `INSERT INTO stream_events (id, workspace_id, stream_id, sequence, broadcast_sequence, event_type, payload)
       VALUES ($1, $2, $3, 1, 1, 'message_created', $4)`,
      [ids.event, wsB, ids.stream, JSON.stringify({ messageId: ids.message, origin: "b" })]
    )
    return { wsA, wsB, ids }
  }

  async function readWorkspace(ws: string, ids: Ids) {
    const stream = await StreamRepository.findById(pool, ws, ids.stream)
    const thread = await StreamRepository.findByAnchor(pool, ws, ids.stream, ids.message)
    const message = await MessageRepository.findById(pool, ws, ids.message)
    const sent = await MessageRepository.findByClientMessageId(pool, ws, ids.stream, CLIENT_MESSAGE_ID)
    const attachment = await AttachmentRepository.findById(pool, ws, ids.attachment)
    const user = await UserRepository.findById(pool, ws, ids.user)
    const timeline = await StreamEventRepository.list(pool, ws, ids.stream)
    const event = await StreamEventRepository.findById(pool, ws, ids.event)

    return {
      stream: stream && { id: stream.id, workspaceId: stream.workspaceId, displayName: stream.displayName },
      thread: thread && { id: thread.id, workspaceId: thread.workspaceId, displayName: thread.displayName },
      message: message && { id: message.id, contentMarkdown: message.contentMarkdown, reactions: message.reactions },
      sent: sent && { id: sent.id, contentMarkdown: sent.contentMarkdown },
      attachment: attachment && {
        id: attachment.id,
        workspaceId: attachment.workspaceId,
        filename: attachment.filename,
      },
      user: user && { id: user.id, workspaceId: user.workspaceId, name: user.name },
      timeline: timeline.map((row) => ({ id: row.id, sequence: row.sequence, payload: row.payload })),
      event: event && { id: event.id, payload: event.payload },
    }
  }

  function expectedRows(ws: string, ids: Ids, label: "a" | "b", reactions: Record<string, string[]>) {
    const payload = { messageId: ids.message, origin: label }
    return {
      stream: { id: ids.stream, workspaceId: ws, displayName: `stream ${label}` },
      thread: { id: ids.thread, workspaceId: ws, displayName: `thread ${label}` },
      message: { id: ids.message, contentMarkdown: `message ${label}`, reactions },
      sent: { id: ids.message, contentMarkdown: `message ${label}` },
      attachment: { id: ids.attachment, workspaceId: ws, filename: `file-${label}.png` },
      user: { id: ids.user, workspaceId: ws, name: `user ${label}` },
      timeline: [{ id: ids.event, sequence: 1n, payload }],
      event: { id: ids.event, payload },
    }
  }

  test("should read only its own row on every table when both workspaces hold the same ids", async () => {
    const { wsA, wsB, ids } = await seedPair()
    const reactions = { "👍": [ids.user] }

    expect(await readWorkspace(wsA, ids)).toEqual(expectedRows(wsA, ids, "a", reactions))
    expect(await readWorkspace(wsB, ids)).toEqual(expectedRows(wsB, ids, "b", reactions))
  })

  test("should leave the first workspace's rows unchanged when the second one writes through the old arbiters", async () => {
    const { wsA, wsB, ids } = await seedPair()

    const writes = {
      threadAgain: await StreamRepository.insertThreadOrFind(pool, {
        id: streamId(),
        workspaceId: wsB,
        type: StreamTypes.THREAD,
        visibility: Visibilities.PRIVATE,
        displayName: "thread again",
        parentStreamId: ids.stream,
        parentAnchorId: ids.message,
        rootStreamId: ids.stream,
        createdBy: ids.user,
      }),
      messageAgain: await MessageRepository.insert(pool, {
        id: messageId(),
        workspaceId: wsB,
        streamId: ids.stream,
        sequence: 2n,
        authorId: ids.user,
        authorType: AuthorTypes.USER,
        clientMessageId: CLIENT_MESSAGE_ID,
        ...testMessageContent("message again"),
      }),
      reactionAgain: await MessageRepository.addReaction(pool, wsB, ids.message, "👍", ids.user),
      reactionAdded: await MessageRepository.addReaction(pool, wsB, ids.message, "🎉", ids.user),
    }

    expect({
      threadAgain: { id: writes.threadAgain.stream.id, created: writes.threadAgain.created },
      messageAgain: { id: writes.messageAgain.id, contentMarkdown: writes.messageAgain.contentMarkdown },
      reactionAgain: writes.reactionAgain?.reactions,
      reactionAdded: writes.reactionAdded?.reactions,
    }).toEqual({
      threadAgain: { id: ids.thread, created: false },
      messageAgain: { id: ids.message, contentMarkdown: "message b" },
      reactionAgain: { "👍": [ids.user] },
      reactionAdded: { "👍": [ids.user], "🎉": [ids.user] },
    })
    expect(await readWorkspace(wsA, ids)).toEqual(expectedRows(wsA, ids, "a", { "👍": [ids.user] }))
    expect(await readWorkspace(wsB, ids)).toEqual(expectedRows(wsB, ids, "b", { "👍": [ids.user], "🎉": [ids.user] }))
  })
})
