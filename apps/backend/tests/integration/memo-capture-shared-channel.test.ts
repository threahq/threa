import { DisabledAnalyticsReporter, streamConnectionId } from "@threahq/backend-common"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import type { JSONContent } from "@threahq/types"
import type { Pool } from "pg"
import { ConversationStatuses } from "@threahq/types"
import { ConversationRepository } from "../../src/features/conversations"
import { MemoRepository, MemoService, PendingItemRepository } from "../../src/features/memos"
import type { ConversationClassification } from "../../src/features/memos/classifier"
import { MessageRepository, type Message } from "../../src/features/messaging"
import { StreamRepository } from "../../src/features/streams"
import { WorkspaceRepository } from "../../src/features/workspaces"
import {
  conversationId,
  memoId,
  messageId,
  pendingItemId,
  sessionId,
  streamId,
  userId,
  workspaceId,
} from "../../src/lib/id"
import {
  addTestMember,
  seedCompletedLinkPreview,
  setupTestDatabase,
  testMessageContent,
  withTransaction,
} from "./setup"

const worthy: ConversationClassification = {
  isKnowledgeWorthy: true,
  shouldReviseExisting: false,
  revisionReason: null,
  confidence: 0.9,
  containsActionItems: false,
}

const SAME_EMBEDDING = Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0))

interface Workspace {
  id: string
  ownerId: string
}

describe("memo capture in a channel its workspace shares as host", () => {
  let pool: Pool
  let nextSequence = 1n
  let embedCalls = 0
  let embedAlike: boolean
  let classifierMemos: string[][]
  let memorizerContexts: { memoryContext: string[]; existingTags: string[] }[]
  let transcripts: string[][]

  function embedding(): number[] {
    if (embedAlike) return SAME_EMBEDDING
    const axis = 1 + embedCalls++
    return Array.from({ length: 1536 }, (_, i) => (i === axis ? 1 : 0))
  }

  function service(): MemoService {
    return new MemoService({
      analyticsReporter: new DisabledAnalyticsReporter(),
      pool,
      classifier: {
        classifyConversation: async (_conversation: unknown, _messages: unknown, existing: { abstract: string }[]) => {
          classifierMemos.push(existing.map((m) => m.abstract))
          return worthy
        },
      },
      memorizer: {
        memorizeConversation: async (
          _formatted: string,
          context: { memoryContext: { abstract: string }[]; existingTags: string[]; content: { id: string }[] }
        ) => {
          memorizerContexts.push({
            memoryContext: context.memoryContext.map((m) => m.abstract),
            existingTags: context.existingTags,
          })
          return [
            {
              title: "Start with auth",
              abstract: "The migration starts with the auth service.",
              keyPoints: [],
              sourceMessageIds: context.content.map((m) => m.id),
              knowledgeType: "decision",
              tags: [],
            },
          ]
        },
      } as never,
      embeddingService: { embedBatch: async (texts: string[]) => texts.map(() => embedding()) } as never,
      messageFormatter: {
        formatMessages: async (_pool: unknown, _workspaceId: string, messages: Message[]) => {
          transcripts.push(messages.map((message) => message.contentMarkdown))
          return "formatted transcript"
        },
      } as never,
    })
  }

  async function seedWorkspace(): Promise<Workspace> {
    const id = workspaceId()
    return withTransaction(pool, async (client) => {
      const workosUserId = userId()
      await WorkspaceRepository.insert(client, {
        id,
        name: "Memo Capture Shared Channel",
        slug: `memo-capture-shared-channel-${id}`,
        createdBy: workosUserId,
      })
      return { id, ownerId: (await addTestMember(client, id, workosUserId)).id }
    })
  }

  async function seedChannel(ws: Workspace, visibility: "public" | "private" = "public"): Promise<string> {
    const id = streamId()
    await StreamRepository.insert(pool, { id, workspaceId: ws.id, type: "channel", visibility, createdBy: ws.ownerId })
    return id
  }

  async function seedThread(ws: Workspace, parent: string, root: string, anchorId: string): Promise<string> {
    const id = streamId()
    await StreamRepository.insert(pool, {
      id,
      workspaceId: ws.id,
      type: "thread",
      visibility: "private",
      createdBy: ws.ownerId,
      parentStreamId: parent,
      rootStreamId: root,
      parentAnchorId: anchorId,
    })
    return id
  }

  async function share(ws: Workspace, channel: string): Promise<void> {
    await pool.query(
      `INSERT INTO stream_connections (workspace_id, id, role, state, stream_id, remote_workspace_id, remote_workspace_name, expires_at, revision)
       VALUES ($1, $2, 'host', 'active', $3, $4, 'Partner', NOW() + INTERVAL '1 day', 1)`,
      [ws.id, streamConnectionId(), channel, workspaceId()]
    )
  }

  async function seedMessage(
    ws: Workspace,
    stream: string,
    content: Pick<Message, "contentJson" | "contentMarkdown"> = testMessageContent("we start the migration with auth")
  ): Promise<string> {
    const id = messageId()
    await MessageRepository.insert(pool, {
      workspaceId: ws.id,
      id,
      streamId: stream,
      sequence: nextSequence++,
      authorId: ws.ownerId,
      authorType: "user",
      ...content,
    })
    return id
  }

  /**
   * An active memo sourced in `stream`. Given `sharedRootStreamId`, it is a conversation memo captured inside that
   * share, the only kind capture stamps; otherwise a message memo.
   */
  async function seedMemo(
    ws: Workspace,
    stream: string,
    memo: { abstract: string; tags: string[]; sharedRootStreamId?: string }
  ): Promise<void> {
    const id = memoId()
    const source = memo.sharedRootStreamId
      ? { memoType: "conversation" as const, sourceConversationId: await seedConversation(ws, stream) }
      : { memoType: "message" as const, sourceMessageId: await seedMessage(ws, stream) }
    await MemoRepository.insert(pool, {
      id,
      workspaceId: ws.id,
      ...source,
      title: memo.abstract,
      abstract: memo.abstract,
      sourceMessageIds: [],
      participantIds: [],
      knowledgeType: "decision",
      tags: memo.tags,
      sharedRootStreamId: memo.sharedRootStreamId,
    })
    await MemoRepository.updateEmbedding(pool, ws.id, id, SAME_EMBEDDING)
  }

  /** A settled conversation of these messages in `stream`. */
  async function seedConversation(ws: Workspace, stream: string, messageIds: string[] = []): Promise<string> {
    const id = conversationId()
    await withTransaction(pool, async (client) => {
      await ConversationRepository.insert(client, {
        id,
        streamId: stream,
        workspaceId: ws.id,
        status: ConversationStatuses.RESOLVED,
      })
      for (const message of messageIds) {
        await ConversationRepository.addPrimaryMessage(client, ws.id, id, message, ws.ownerId)
      }
    })
    return id
  }

  /** A settled conversation of these messages in `stream`, queued for capture. */
  async function queueConversation(ws: Workspace, stream: string, messageIds: string[]): Promise<string> {
    const id = await seedConversation(ws, stream, messageIds)
    await withTransaction(pool, (client) =>
      PendingItemRepository.queue(client, [
        { id: pendingItemId(), workspaceId: ws.id, streamId: stream, itemType: "conversation", itemId: id },
      ])
    )
    return id
  }

  async function seedPreview(ws: Workspace, message: string): Promise<void> {
    await seedCompletedLinkPreview(pool, {
      workspaceId: ws.id,
      messageId: message,
      url: "https://github.com/acme/private/pull/7",
      title: "Rotate the prod password",
    })
  }

  async function capturedMemos(ws: Workspace): Promise<{ title: string; shared_root_stream_id: string | null }[]> {
    const result = await pool.query(
      `SELECT title, shared_root_stream_id FROM memos WHERE workspace_id = $1 AND title = 'Start with auth'`,
      [ws.id]
    )
    return result.rows
  }

  function linkTo(channel: string, slug: string): Pick<Message, "contentJson" | "contentMarkdown"> {
    const contentJson: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "the plan is in " },
            { type: "channelLink", attrs: { id: channel, slug } },
          ],
        },
      ],
    }
    return { contentJson, contentMarkdown: `the plan is in [#${slug}](channel:${channel})` }
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  beforeEach(() => {
    embedAlike = false
    classifierMemos = []
    memorizerContexts = []
    transcripts = []
  })

  afterAll(async () => {
    await pool.end()
  })

  test("should read the conversation as the partner does and stamp its memo when the channel is shared", async () => {
    const ws = await seedWorkspace()
    const channel = await seedChannel(ws)
    const outside = await seedChannel(ws, "private")
    const linked = await seedMessage(ws, channel, linkTo(outside, "secret-plans"))
    const previewed = await seedMessage(ws, channel, linkTo(channel, "shared"))
    await seedPreview(ws, previewed)
    const conversation = await queueConversation(ws, channel, [linked, previewed])
    await seedMemo(ws, channel, { abstract: "pre-share", tags: ["pre-share-tag"] })
    await seedMemo(ws, channel, { abstract: "while shared", tags: ["shared-tag"], sharedRootStreamId: channel })
    await MemoRepository.insert(pool, {
      id: memoId(),
      workspaceId: ws.id,
      memoType: "conversation",
      sourceConversationId: conversation,
      title: "pre-share capture",
      abstract: "pre-share capture",
      sourceMessageIds: [],
      participantIds: [],
      knowledgeType: "decision",
    })
    await share(ws, channel)

    await service().processBatch(ws.id, channel)

    expect({ transcripts, classifierMemos, memorizerContexts, captured: await capturedMemos(ws) }).toEqual({
      transcripts: [["the plan is in #secret-plans", `the plan is in [#shared](channel:${channel})`]],
      classifierMemos: [[]],
      memorizerContexts: [{ memoryContext: ["while shared"], existingTags: ["shared-tag"] }],
      captured: [{ title: "Start with auth", shared_root_stream_id: channel }],
    })
  })

  test("should keep a memo made before the share from blocking a near-identical one when the channel is shared", async () => {
    const ws = await seedWorkspace()
    const channel = await seedChannel(ws)
    await seedMemo(ws, channel, { abstract: "pre-share", tags: [] })
    await queueConversation(ws, channel, [await seedMessage(ws, channel), await seedMessage(ws, channel)])
    await share(ws, channel)
    embedAlike = true

    await service().processBatch(ws.id, channel)

    expect(await capturedMemos(ws)).toEqual([{ title: "Start with auth", shared_root_stream_id: channel }])
  })

  test("should let a memo made while shared block a near-identical one when the channel is shared", async () => {
    const ws = await seedWorkspace()
    const channel = await seedChannel(ws)
    await seedMemo(ws, channel, { abstract: "while shared", tags: [], sharedRootStreamId: channel })
    await queueConversation(ws, channel, [await seedMessage(ws, channel), await seedMessage(ws, channel)])
    await share(ws, channel)
    embedAlike = true

    await service().processBatch(ws.id, channel)

    const pending = await pool.query(
      `SELECT processed_at IS NOT NULL AS processed, failed_attempts FROM memo_pending_items WHERE workspace_id = $1`,
      [ws.id]
    )
    expect({ captured: await capturedMemos(ws), pending: pending.rows }).toEqual({
      captured: [],
      pending: [{ processed: true, failed_attempts: 0 }],
    })
  })

  test("should keep a memo made before the share from the classifier when it cites a since-edited message in the shared channel", async () => {
    const ws = await seedWorkspace()
    const channel = await seedChannel(ws)
    const cited = await seedMessage(ws, channel)
    const saved = memoId()
    await MemoRepository.insert(pool, {
      id: saved,
      workspaceId: ws.id,
      memoType: "message",
      sourceMessageId: cited,
      title: "saved before the share",
      abstract: "saved before the share",
      sourceMessageIds: [cited],
      participantIds: [],
      knowledgeType: "decision",
    })
    await pool.query(`UPDATE memos SET created_at = NOW() - INTERVAL '1 hour' WHERE workspace_id = $1 AND id = $2`, [
      ws.id,
      saved,
    ])
    await pool.query(`UPDATE messages SET edited_at = NOW() WHERE workspace_id = $1 AND id = $2`, [ws.id, cited])
    await queueConversation(ws, channel, [cited, await seedMessage(ws, channel)])
    await share(ws, channel)

    await service().processBatch(ws.id, channel)

    const status = await pool.query(`SELECT status FROM memos WHERE workspace_id = $1 AND id = $2`, [ws.id, saved])
    expect({ classifierMemos, status: status.rows }).toEqual({
      classifierMemos: [[]],
      status: [{ status: "active" }],
    })
  })

  test("should fail only the conversation the partner's view cannot carry when the channel is shared", async () => {
    const ws = await seedWorkspace()
    const channel = await seedChannel(ws)
    const unreadable = await queueConversation(ws, channel, [
      await seedMessage(ws, channel, {
        contentJson: {
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: "u", marks: [{ type: "underline" }] }] }],
        },
        contentMarkdown: "u",
      }),
      await seedMessage(ws, channel),
    ])
    await queueConversation(ws, channel, [await seedMessage(ws, channel), await seedMessage(ws, channel)])
    await share(ws, channel)

    await service().processBatch(ws.id, channel)

    const pending = await pool.query(
      `SELECT item_id, failed_attempts FROM memo_pending_items WHERE workspace_id = $1 AND processed_at IS NULL`,
      [ws.id]
    )
    expect({ captured: await capturedMemos(ws), pending: pending.rows }).toEqual({
      captured: [{ title: "Start with auth", shared_root_stream_id: channel }],
      pending: [{ item_id: unreadable, failed_attempts: 1 }],
    })
  })

  test("should stamp a memo from a reply thread nested under the shared channel when the channel is shared", async () => {
    const ws = await seedWorkspace()
    const channel = await seedChannel(ws)
    const thread = await seedThread(ws, channel, channel, await seedMessage(ws, channel))
    const nested = await seedThread(ws, thread, channel, await seedMessage(ws, thread))
    await queueConversation(ws, nested, [await seedMessage(ws, nested), await seedMessage(ws, nested)])
    await share(ws, channel)

    await service().processBatch(ws.id, nested)

    expect(await capturedMemos(ws)).toEqual([{ title: "Start with auth", shared_root_stream_id: channel }])
  })

  test("should capture a card-anchored thread unguarded when its channel is shared", async () => {
    const ws = await seedWorkspace()
    const channel = await seedChannel(ws)
    const outside = await seedChannel(ws, "private")
    const thread = await seedThread(ws, channel, channel, sessionId())
    await seedMemo(ws, thread, { abstract: "pre-share", tags: ["pre-share-tag"] })
    const linked = await seedMessage(ws, thread, linkTo(outside, "secret-plans"))
    const previewed = await seedMessage(ws, thread)
    await seedPreview(ws, previewed)
    await queueConversation(ws, thread, [linked, previewed])
    await share(ws, channel)

    await service().processBatch(ws.id, thread)

    expect({ transcripts, memorizerContexts, captured: await capturedMemos(ws) }).toEqual({
      transcripts: [
        [
          `the plan is in [#secret-plans](channel:${outside})`,
          expect.stringMatching(/^we start the migration with auth\n\n.*Rotate the prod password/s),
        ],
      ],
      memorizerContexts: [{ memoryContext: ["pre-share"], existingTags: ["pre-share-tag"] }],
      captured: [{ title: "Start with auth", shared_root_stream_id: null }],
    })
  })
})
