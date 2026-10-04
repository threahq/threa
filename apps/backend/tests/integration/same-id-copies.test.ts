import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { AuthorTypes, NotificationLevels, StreamTypes, Visibilities } from "@threahq/types"
import { setupTestDatabase, testMessageContent } from "./setup"
import { AttachmentRepository } from "../../src/features/attachments"
import { MessageRepository, MessageVersionRepository } from "../../src/features/messaging"
import {
  ReadStateRepository,
  StreamEventRepository,
  StreamMemberRepository,
  StreamRepository,
} from "../../src/features/streams"
import { UserRepository } from "../../src/features/workspaces"
import { attachmentId, eventId, messageId, messageVersionId, streamId, userId, workspaceId } from "../../src/lib/id"

const CLIENT_MESSAGE_ID = "client-message-1"

/**
 * Threa Connect copies rows into a partner workspace under the same ids and
 * writes per-copy state beside them, so every table keyed by a copied id must
 * let workspace A and workspace B each hold a row for one id and read back only
 * their own.
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
    version: string
  }

  const NOTIFICATION_LEVEL = { a: NotificationLevels.MUTED, b: NotificationLevels.MENTIONS } as const

  async function seedWorkspace(ws: string, ids: Ids, label: "a" | "b", events: string[]) {
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
    await StreamMemberRepository.insert(pool, ws, ids.stream, ids.user)
    await StreamMemberRepository.update(pool, ws, ids.stream, ids.user, {
      notificationLevel: NOTIFICATION_LEVEL[label],
    })
    for (const id of events) {
      await StreamEventRepository.insert(pool, {
        id,
        workspaceId: ws,
        streamId: ids.stream,
        eventType: "message_created",
        payload: { messageId: ids.message, origin: label },
      })
    }
    await ReadStateRepository.set(pool, ws, ids.stream, ids.user, events[events.length - 1])
    await MessageVersionRepository.insert(pool, {
      id: ids.version,
      workspaceId: ws,
      messageId: ids.message,
      versionNumber: 1,
      editedBy: ids.user,
      ...testMessageContent(`message ${label} before edit`),
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
      version: messageVersionId(),
    }
    const events = { a: [ids.event], b: [ids.event, eventId()] }
    await seedWorkspace(wsA, ids, "a", events.a)
    await seedWorkspace(wsB, ids, "b", events.b)
    return { wsA, wsB, ids, events }
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
    const member = await StreamMemberRepository.findByStreamAndMember(pool, ws, ids.stream, ids.user)
    const readState = await ReadStateRepository.get(pool, ws, ids.stream, ids.user)
    const versions = await MessageVersionRepository.listByMessageId(pool, ws, ids.message)

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
      timeline: timeline.map((row) => ({
        id: row.id,
        sequence: row.sequence,
        broadcastSequence: row.broadcastSequence,
        payload: row.payload,
      })),
      event: event && { id: event.id, payload: event.payload },
      member: member && { memberId: member.memberId, notificationLevel: member.notificationLevel },
      readState: readState && { workspaceId: readState.workspaceId, lastReadEventId: readState.lastReadEventId },
      versions: versions.map((row) => ({
        id: row.id,
        versionNumber: row.versionNumber,
        contentMarkdown: row.contentMarkdown,
      })),
    }
  }

  function expectedRows(ws: string, ids: Ids, label: "a" | "b", reactions: Record<string, string[]>, events: string[]) {
    const payload = { messageId: ids.message, origin: label }
    return {
      stream: { id: ids.stream, workspaceId: ws, displayName: `stream ${label}` },
      thread: { id: ids.thread, workspaceId: ws, displayName: `thread ${label}` },
      message: { id: ids.message, contentMarkdown: `message ${label}`, reactions },
      sent: { id: ids.message, contentMarkdown: `message ${label}` },
      attachment: { id: ids.attachment, workspaceId: ws, filename: `file-${label}.png` },
      user: { id: ids.user, workspaceId: ws, name: `user ${label}` },
      timeline: events.map((id, index) => ({
        id,
        sequence: BigInt(index + 1),
        broadcastSequence: BigInt(index + 1),
        payload,
      })),
      event: { id: ids.event, payload },
      member: { memberId: ids.user, notificationLevel: NOTIFICATION_LEVEL[label] },
      readState: { workspaceId: ws, lastReadEventId: events[events.length - 1] },
      versions: [{ id: ids.version, versionNumber: 1, contentMarkdown: `message ${label} before edit` }],
    }
  }

  test("should read only its own row on every table when both workspaces hold the same ids", async () => {
    const { wsA, wsB, ids, events } = await seedPair()
    const reactions = { "👍": [ids.user] }

    expect(await readWorkspace(wsA, ids)).toEqual(expectedRows(wsA, ids, "a", reactions, events.a))
    expect(await readWorkspace(wsB, ids)).toEqual(expectedRows(wsB, ids, "b", reactions, events.b))
  })

  test("should leave the first workspace's rows unchanged when the second one writes the same ids again", async () => {
    const { wsA, wsB, ids, events } = await seedPair()

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
      memberAgain: await StreamMemberRepository.insert(pool, wsB, ids.stream, ids.user),
    }

    expect({
      threadAgain: {
        id: writes.threadAgain.stream.id,
        workspaceId: writes.threadAgain.stream.workspaceId,
        created: writes.threadAgain.created,
      },
      messageAgain: { id: writes.messageAgain.id, contentMarkdown: writes.messageAgain.contentMarkdown },
      reactionAgain: writes.reactionAgain?.reactions,
      reactionAdded: writes.reactionAdded?.reactions,
      memberAgain: writes.memberAgain.notificationLevel,
    }).toEqual({
      threadAgain: { id: ids.thread, workspaceId: wsB, created: false },
      messageAgain: { id: ids.message, contentMarkdown: "message b" },
      reactionAgain: { "👍": [ids.user] },
      reactionAdded: { "👍": [ids.user], "🎉": [ids.user] },
      memberAgain: NOTIFICATION_LEVEL.b,
    })
    expect(await readWorkspace(wsA, ids)).toEqual(expectedRows(wsA, ids, "a", { "👍": [ids.user] }, events.a))
    expect(await readWorkspace(wsB, ids)).toEqual(
      expectedRows(wsB, ids, "b", { "👍": [ids.user], "🎉": [ids.user] }, events.b)
    )
  })
})
