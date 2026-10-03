import { DisabledAnalyticsReporter } from "@threahq/backend-common"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { ConversationStatuses, type StreamType, type Visibility } from "@threahq/types"
import { ConversationRepository } from "../../src/features/conversations"
import { MemoRepository, MemoService, PendingItemRepository } from "../../src/features/memos"
import type { ConversationClassification } from "../../src/features/memos/classifier"
import { MessageRepository } from "../../src/features/messaging"
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
import { addTestMember, setupTestDatabase, testMessageContent, withTransaction } from "./setup"

const worthy: ConversationClassification = {
  isKnowledgeWorthy: true,
  shouldReviseExisting: false,
  revisionReason: null,
  confidence: 0.9,
  containsActionItems: false,
}

let embedCalls = 0
function nextEmbedding(): number[] {
  const axis = embedCalls++
  return Array.from({ length: 1536 }, (_, i) => (i === axis ? 1 : 0))
}

interface Workspace {
  id: string
  ownerId: string
  otherId: string
}

describe("memo capture: model context honors memo scope", () => {
  let pool: Pool
  let nextSequence = 1n
  let classifierMemos: string[][]
  let memorizerContexts: { memoryContext: string[]; existingTags: string[] }[]

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
          context: { memoryContext: string[]; existingTags: string[]; content: { id: string }[] }
        ) => {
          memorizerContexts.push({ memoryContext: context.memoryContext, existingTags: context.existingTags })
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
      embeddingService: { embedBatch: async (texts: string[]) => texts.map(() => nextEmbedding()) } as never,
      messageFormatter: { formatMessages: async () => "formatted transcript" } as never,
    })
  }

  async function seedWorkspace(): Promise<Workspace> {
    const id = workspaceId()
    return withTransaction(pool, async (client) => {
      const workosUserId = userId()
      await WorkspaceRepository.insert(client, {
        id,
        name: "Memo Capture Context Scope",
        slug: `memo-capture-context-scope-${id}`,
        createdBy: workosUserId,
      })
      return {
        id,
        ownerId: (await addTestMember(client, id, workosUserId)).id,
        otherId: (await addTestMember(client, id, userId())).id,
      }
    })
  }

  async function seedStream(
    ws: Workspace,
    params: { type: StreamType; visibility: Visibility; createdBy: string } | { threadOf: string; anchorId: string }
  ): Promise<string> {
    const id = streamId()
    await StreamRepository.insert(pool, {
      id,
      workspaceId: ws.id,
      ...("threadOf" in params
        ? {
            type: "thread",
            visibility: "private",
            createdBy: ws.ownerId,
            parentStreamId: params.threadOf,
            rootStreamId: params.threadOf,
            parentAnchorId: params.anchorId,
          }
        : params),
    })
    return id
  }

  async function seedMessage(ws: Workspace, stream: string): Promise<string> {
    const id = messageId()
    await MessageRepository.insert(pool, {
      id,
      streamId: stream,
      sequence: nextSequence++,
      authorId: ws.ownerId,
      authorType: "user",
      ...testMessageContent("we start the migration with the auth service"),
    })
    return id
  }

  /** A message memo sourced in `stream`; private to `owner` when given. */
  async function seedMemo(
    ws: Workspace,
    stream: string,
    memo: { abstract: string; tags: string[]; owner?: string }
  ): Promise<void> {
    await MemoRepository.insert(pool, {
      id: memoId(),
      workspaceId: ws.id,
      memoType: "message",
      sourceMessageId: await seedMessage(ws, stream),
      title: memo.abstract,
      abstract: memo.abstract,
      sourceMessageIds: [],
      participantIds: [],
      knowledgeType: "decision",
      tags: memo.tags,
      ...(memo.owner ? { scope: "user", scopeUserId: memo.owner } : {}),
    })
  }

  /** A settled two-message conversation in `stream`, queued for capture. */
  async function queueConversation(ws: Workspace, stream: string): Promise<void> {
    const id = conversationId()
    await withTransaction(pool, async (client) => {
      await ConversationRepository.insert(client, {
        id,
        streamId: stream,
        workspaceId: ws.id,
        status: ConversationStatuses.RESOLVED,
      })
      for (let i = 0; i < 2; i++) {
        await ConversationRepository.addPrimaryMessage(client, ws.id, id, await seedMessage(ws, stream), ws.ownerId)
      }
      await PendingItemRepository.queue(client, [
        { id: pendingItemId(), workspaceId: ws.id, streamId: stream, itemType: "conversation", itemId: id },
      ])
    })
  }

  async function captureSession(ws: Workspace, stream: string): Promise<void> {
    await service().captureSessionReflection({
      workspaceId: ws.id,
      streamId: stream,
      sessionId: sessionId(),
      digest: "Trigger: where does the migration start?",
      anchorMessageId: await seedMessage(ws, stream),
      participantIds: [ws.ownerId],
      citedStreamIds: [],
      citedMessageIds: [],
    })
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  beforeEach(() => {
    classifierMemos = []
    memorizerContexts = []
  })

  afterAll(async () => {
    await pool.end()
  })

  test("a shared channel's capture never shows the model a private memo or its tags", async () => {
    const ws = await seedWorkspace()
    const channel = await seedStream(ws, { type: "channel", visibility: "public", createdBy: ws.ownerId })
    await seedMemo(ws, channel, { abstract: "shared", tags: ["shared-tag"] })
    await seedMemo(ws, channel, { abstract: "private", tags: ["private-tag"], owner: ws.otherId })
    await queueConversation(ws, channel)

    await service().processBatch(ws.id, channel)

    expect(memorizerContexts).toEqual([{ memoryContext: ["shared"], existingTags: ["shared-tag"] }])
  })

  test("a public channel's capture sees tags from other public channels but not private ones", async () => {
    const ws = await seedWorkspace()
    const channel = await seedStream(ws, { type: "channel", visibility: "public", createdBy: ws.ownerId })
    const otherPublic = await seedStream(ws, { type: "channel", visibility: "public", createdBy: ws.ownerId })
    const privateChannel = await seedStream(ws, { type: "channel", visibility: "private", createdBy: ws.otherId })
    await seedMemo(ws, otherPublic, { abstract: "public", tags: ["public-tag"] })
    await seedMemo(ws, privateChannel, { abstract: "secret", tags: ["secret-tag"] })
    await queueConversation(ws, channel)

    await service().processBatch(ws.id, channel)

    expect(memorizerContexts).toEqual([{ memoryContext: [], existingTags: ["public-tag"] }])
  })

  test("a session in a shared channel's thread never shows the model a private memo saved there", async () => {
    const ws = await seedWorkspace()
    const channel = await seedStream(ws, { type: "channel", visibility: "public", createdBy: ws.ownerId })
    const thread = await seedStream(ws, { threadOf: channel, anchorId: await seedMessage(ws, channel) })
    await seedMemo(ws, thread, { abstract: "private", tags: ["private-tag"], owner: ws.ownerId })

    await captureSession(ws, thread)

    expect({ classifierMemos, memorizerContexts }).toEqual({
      classifierMemos: [[]],
      memorizerContexts: [{ memoryContext: [], existingTags: [] }],
    })
  })

  test("a scratchpad session sees its owner's private memos but no one else's", async () => {
    const ws = await seedWorkspace()
    const scratchpad = await seedStream(ws, { type: "scratchpad", visibility: "private", createdBy: ws.ownerId })
    const theirs = await seedStream(ws, { type: "scratchpad", visibility: "private", createdBy: ws.otherId })
    await seedMemo(ws, scratchpad, { abstract: "mine", tags: ["my-tag"], owner: ws.ownerId })
    await seedMemo(ws, theirs, { abstract: "theirs", tags: ["their-tag"], owner: ws.otherId })

    await captureSession(ws, scratchpad)

    expect({ classifierMemos, memorizerContexts }).toEqual({
      classifierMemos: [["mine"]],
      memorizerContexts: [{ memoryContext: ["mine"], existingTags: ["my-tag"] }],
    })
  })
})
