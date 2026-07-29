/**
 * getBoardMessages projection — the conversation panel's server backfill path.
 *
 * `MessageRepository.findByIds` returns soft-deleted rows (other callers depend
 * on that) and `softDelete` retains `content_markdown`, so the projection is the
 * only place a deleted body can be dropped. Verified against the real schema
 * (INV-68): seed rows, run the real projection, assert on what comes back.
 */

import { describe, test, expect, beforeAll, afterAll, spyOn } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase, testMessageContent, withTransaction, addTestMember } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamRepository } from "../../src/features/streams"
import { MessageRepository } from "../../src/features/messaging"
import { AttachmentRepository } from "../../src/features/attachments"
import { ConversationRepository, ConversationService } from "../../src/features/conversations"
import { userId, workspaceId, streamId, messageId, conversationId, attachmentId } from "../../src/lib/id"

describe("ConversationService.getBoardMessages", () => {
  let pool: Pool
  let service: ConversationService
  let testUserId: string
  let testWorkspaceId: string
  let testStreamId: string
  let convId: string
  let liveMessageId: string
  let deletedMessageId: string
  let allDeletedConvId: string
  let allDeletedMessageId: string

  beforeAll(async () => {
    pool = await setupTestDatabase()
    service = new ConversationService(pool)

    testUserId = userId()
    testWorkspaceId = workspaceId()
    testStreamId = streamId()
    convId = conversationId()
    liveMessageId = messageId()
    deletedMessageId = messageId()
    allDeletedConvId = conversationId()
    allDeletedMessageId = messageId()

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: testWorkspaceId,
        name: "Board Messages WS",
        slug: `board-msgs-${testWorkspaceId}`,
        createdBy: testUserId,
      })
      testUserId = (await addTestMember(client, testWorkspaceId, testUserId)).id
      await StreamRepository.insert(client, {
        id: testStreamId,
        workspaceId: testWorkspaceId,
        type: "channel",
        visibility: "private",
        companionMode: "off",
        createdBy: testUserId,
      })
      await MessageRepository.insert(client, {
        id: liveMessageId,
        streamId: testStreamId,
        sequence: BigInt(1),
        authorId: testUserId,
        authorType: "user",
        ...testMessageContent("still here"),
      })
      await MessageRepository.insert(client, {
        id: deletedMessageId,
        streamId: testStreamId,
        sequence: BigInt(2),
        authorId: testUserId,
        authorType: "user",
        ...testMessageContent("the secret pre-deletion body"),
      })
      await MessageRepository.addReaction(client, deletedMessageId, "🔥", testUserId)
      const attachment = await AttachmentRepository.insert(client, {
        id: attachmentId(),
        workspaceId: testWorkspaceId,
        streamId: testStreamId,
        uploadedBy: testUserId,
        filename: "secret.png",
        mimeType: "image/png",
        sizeBytes: 128,
        storagePath: `${testWorkspaceId}/secret.png`,
      })
      await AttachmentRepository.attachToMessage(client, [attachment.id], deletedMessageId, testStreamId)
      const liveAttachment = await AttachmentRepository.insert(client, {
        id: attachmentId(),
        workspaceId: testWorkspaceId,
        streamId: testStreamId,
        uploadedBy: testUserId,
        filename: "public.png",
        mimeType: "image/png",
        sizeBytes: 64,
        storagePath: `${testWorkspaceId}/public.png`,
      })
      await AttachmentRepository.attachToMessage(client, [liveAttachment.id], liveMessageId, testStreamId)
      await MessageRepository.softDelete(client, deletedMessageId)
      await ConversationRepository.insert(client, {
        id: convId,
        streamId: testStreamId,
        workspaceId: testWorkspaceId,
      })
      await ConversationRepository.addPrimaryMessage(client, testWorkspaceId, convId, liveMessageId, testUserId)
      await ConversationRepository.addPrimaryMessage(client, testWorkspaceId, convId, deletedMessageId, testUserId)

      await MessageRepository.insert(client, {
        id: allDeletedMessageId,
        streamId: testStreamId,
        sequence: BigInt(3),
        authorId: testUserId,
        authorType: "user",
        ...testMessageContent("wholly deleted conversation"),
      })
      await MessageRepository.softDelete(client, allDeletedMessageId)
      await ConversationRepository.insert(client, {
        id: allDeletedConvId,
        streamId: testStreamId,
        workspaceId: testWorkspaceId,
      })
      await ConversationRepository.addPrimaryMessage(
        client,
        testWorkspaceId,
        allDeletedConvId,
        allDeletedMessageId,
        testUserId
      )
    })
  })

  afterAll(async () => {
    await pool.end()
  })

  test("returns a soft-deleted member as a tombstone", async () => {
    const messages = await service.getBoardMessages(testWorkspaceId, convId)
    const tombstone = messages.find((m) => m.id === deletedMessageId)
    expect(tombstone?.deletedAt).toBeInstanceOf(Date)
  })

  test("a tombstone carries no content, reactions, attachments, or link previews", async () => {
    const messages = await service.getBoardMessages(testWorkspaceId, convId)
    const tombstone = messages.find((m) => m.id === deletedMessageId)!
    expect({
      contentMarkdown: tombstone.contentMarkdown,
      reactions: tombstone.reactions,
      attachments: tombstone.attachments,
      linkPreviews: tombstone.linkPreviews,
    }).toEqual({
      contentMarkdown: "",
      reactions: {},
      attachments: [],
      linkPreviews: [],
    })
  })

  test("a live message in the same conversation is unaffected", async () => {
    const messages = await service.getBoardMessages(testWorkspaceId, convId)
    const live = messages.find((m) => m.id === liveMessageId)!
    expect({
      contentMarkdown: live.contentMarkdown,
      deletedAt: live.deletedAt,
      streamId: live.streamId,
      authorId: live.authorId,
    }).toEqual({
      contentMarkdown: "still here",
      deletedAt: null,
      streamId: testStreamId,
      authorId: testUserId,
    })
  })

  test("hydration never sees a deleted id, so no presigned URL is minted for deleted content", async () => {
    const findByMessageIds = spyOn(AttachmentRepository, "findByMessageIds")
    try {
      const messages = await service.getBoardMessages(testWorkspaceId, convId)
      const live = messages.find((m) => m.id === liveMessageId)!
      const tombstone = messages.find((m) => m.id === deletedMessageId)!
      expect(findByMessageIds.mock.calls.map(([, ids]) => ids)).toEqual([[liveMessageId]])
      expect({
        liveFilenames: live.attachments.map((a) => a.filename),
        tombstoneAttachments: tombstone.attachments,
      }).toEqual({ liveFilenames: ["public.png"], tombstoneAttachments: [] })
    } finally {
      findByMessageIds.mockRestore()
    }
  })

  test("a wholly-deleted conversation returns its tombstones without hydrating anything", async () => {
    const findByMessageIds = spyOn(AttachmentRepository, "findByMessageIds")
    try {
      const messages = await service.getBoardMessages(testWorkspaceId, allDeletedConvId)
      expect(findByMessageIds).not.toHaveBeenCalled()
      expect(
        messages.map((m) => ({ id: m.id, contentMarkdown: m.contentMarkdown, deleted: m.deletedAt instanceof Date }))
      ).toEqual([{ id: allDeletedMessageId, contentMarkdown: "", deleted: true }])
    } finally {
      findByMessageIds.mockRestore()
    }
  })
})
