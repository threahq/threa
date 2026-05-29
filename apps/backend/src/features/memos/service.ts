import type { Pool, PoolClient } from "pg"
import { withTransaction, withClient } from "../../db"
import { StreamStateRepository } from "../streams"
import { ConversationRepository } from "../conversations"
import { MessageRepository, type Message } from "../messaging"
import { OutboxRepository } from "../../lib/outbox"
import { UserRepository } from "../workspaces"
import { MemoRepository, type Memo } from "./repository"
import { PendingItemRepository, type PendingMemoItem } from "./pending-item-repository"
import { MemoClassifier } from "./classifier"
import { Memorizer } from "./memorizer"
import { MessageFormatter } from "../../lib/ai/message-formatter"
import type { EmbeddingServiceLike } from "./embedding-service"
import { memoId } from "../../lib/id"
import { logger } from "../../lib/logger"
import { MemoTypes, MemoStatuses } from "@threa/types"
import { MEMO_GEM_CONFIDENCE_FLOOR, MEMO_SINGLE_MESSAGE_AGE_GATE_MS } from "./config"

const MEMORY_CONTEXT_LIMIT = 20
const MIN_CONVERSATION_MESSAGES = 1

export interface ProcessResult {
  processed: number
  memosCreated: number
  /** Subset of created memos that link to (continue/update) an existing memo. */
  memosLinked: number
}

/** Data prepared for memo creation (before DB insert) */
interface MemoToCreate {
  id: string
  workspaceId: string
  memoType: import("@threa/types").MemoType
  sourceMessageId?: string
  sourceConversationId?: string
  title: string
  abstract: string
  keyPoints: string[]
  sourceMessageIds: string[]
  participantIds: string[]
  knowledgeType: import("@threa/types").KnowledgeType
  tags: string[]
  status: import("@threa/types").MemoStatus
  version?: number
  /** Non-destructive link to an existing memo this one continues/updates. */
  parentMemoId?: string
  embedding: number[]
}

/** Outbox event to insert after memo creation */
interface OutboxEvent {
  eventType: "memo:created"
  payload: {
    workspaceId: string
    memoId: string
    memo: import("@threa/types").Memo
  }
}

/** Interface for memo service implementations */
export interface MemoServiceLike {
  processBatch(workspaceId: string, streamId: string): Promise<ProcessResult>
}

export interface MemoServiceConfig {
  pool: Pool
  classifier: MemoClassifier
  memorizer: Memorizer
  embeddingService: EmbeddingServiceLike
  messageFormatter: MessageFormatter
}

export class MemoService implements MemoServiceLike {
  private pool: Pool
  private classifier: MemoClassifier
  private memorizer: Memorizer
  private embeddingService: EmbeddingServiceLike
  private messageFormatter: MessageFormatter

  constructor(config: MemoServiceConfig) {
    this.pool = config.pool
    this.classifier = config.classifier
    this.memorizer = config.memorizer
    this.embeddingService = config.embeddingService
    this.messageFormatter = config.messageFormatter
  }

  /**
   * Process accumulated conversations to extract knowledge-worthy memos.
   *
   * IMPORTANT: This method uses the three-phase pattern (INV-41) to avoid holding
   * database connections during AI calls (which can take 1-5+ seconds):
   *
   * Phase 1: Fetch data with withClient (~100-200ms)
   * Phase 2: AI classification and memorization with no database connection held (1-5+ seconds)
   * Phase 3: Save memos with withTransaction (~100ms)
   *
   * Single-message conversations are deferred (not marked processed) until they are
   * at least MEMO_SINGLE_MESSAGE_AGE_GATE_MS old, giving time for replies to arrive.
   * Deferred streams are retried every ~30s (quiet-interval cycle) until the age gate
   * passes — these are cheap no-op runs (no AI calls).
   */
  async processBatch(workspaceId: string, streamId: string): Promise<ProcessResult> {
    // Phase 1: Fetch all data with withClient (no transaction, fast reads)
    const fetchedData = await withClient(this.pool, async (client) => {
      const pending = await PendingItemRepository.findUnprocessed(client, workspaceId, streamId, {
        limit: 50,
      })

      if (pending.length === 0) {
        return null
      }

      const existingMemos = await MemoRepository.findByStream(client, streamId, {
        status: MemoStatuses.ACTIVE,
        limit: MEMORY_CONTEXT_LIMIT,
        orderBy: "createdAt",
      })

      const existingTags = await MemoRepository.getAllTags(client, workspaceId)

      // Fetch all conversations and their messages for conversation items
      const conversationItemIds = pending.filter((p) => p.itemType === "conversation").map((p) => p.itemId)
      const conversations = new Map<string, NonNullable<Awaited<ReturnType<typeof ConversationRepository.findById>>>>()
      const conversationMessages = new Map<string, Map<string, Message | null>>()
      const existingConversationMemos = new Map<string, Memo[]>()

      for (const convId of conversationItemIds) {
        const conv = await ConversationRepository.findById(client, convId)
        if (conv) {
          conversations.set(convId, conv)
          const msgs = await MessageRepository.findByIds(client, conv.messageIds)
          conversationMessages.set(convId, msgs)
          const existingMemos = await MemoRepository.findActiveBySourceConversation(client, convId)
          existingConversationMemos.set(convId, existingMemos)
        }
      }

      // Pre-format all messages while we have database access (INV-41)
      // Formatting requires resolving author names from the database
      const formattedConversations = new Map<string, string>()
      for (const [convId, msgs] of conversationMessages) {
        const messagesArray = Array.from(msgs.values()).filter((m): m is Message => m !== null)
        if (messagesArray.length > 0) {
          const formatted = await this.messageFormatter.formatMessages(client, workspaceId, messagesArray)
          formattedConversations.set(convId, formatted)
        }
      }

      // Fetch author timezones for date anchoring in memos
      const authorIds = new Set<string>()
      for (const conv of conversations.values()) {
        for (const participantId of conv.participantIds) {
          authorIds.add(participantId)
        }
      }

      const authorTimezones = new Map<string, string | null>()
      if (authorIds.size > 0) {
        const members = await UserRepository.findByIds(client, workspaceId, Array.from(authorIds))
        for (const member of members) {
          authorTimezones.set(member.id, member.timezone)
        }
      }

      return {
        pending,
        existingMemos,
        existingTags,
        conversations,
        conversationMessages,
        existingConversationMemos,
        formattedConversations,
        authorTimezones,
      }
    })

    if (!fetchedData) {
      return { processed: 0, memosCreated: 0, memosLinked: 0 }
    }

    // Phase 2: AI processing (no connection held, can take seconds/minutes)
    const memoryContext = fetchedData.existingMemos.map((m) => m.abstract)
    const memosToCreate: MemoToCreate[] = []
    const outboxEvents: OutboxEvent[] = []
    const deferredItemIds = new Set<string>()
    let memosCreated = 0
    let memosLinked = 0
    let itemsFailed = 0

    // Process conversation items
    const convItems = fetchedData.pending.filter((p) => p.itemType === "conversation")
    for (const item of convItems) {
      try {
        const conversation = fetchedData.conversations.get(item.itemId)
        if (!conversation) {
          logger.warn({ conversationId: item.itemId }, "Conversation not found for memo processing")
          continue
        }

        if (conversation.messageIds.length < MIN_CONVERSATION_MESSAGES) {
          continue
        }

        // Defer young single-message conversations — give time for replies to arrive
        if (conversation.messageIds.length === 1) {
          const ageMs = Date.now() - new Date(conversation.lastActivityAt).getTime()
          if (ageMs < MEMO_SINGLE_MESSAGE_AGE_GATE_MS) {
            deferredItemIds.add(item.id)
            logger.debug(
              { conversationId: conversation.id, ageMs, threshold: MEMO_SINGLE_MESSAGE_AGE_GATE_MS },
              "Deferring young single-message conversation"
            )
            continue
          }
        }

        const messages = fetchedData.conversationMessages.get(item.itemId)
        if (!messages) {
          logger.warn({ conversationId: conversation.id }, "No messages found for conversation")
          continue
        }

        const messagesArray = Array.from(messages.values()).filter((m): m is Message => m !== null)
        if (messagesArray.length === 0) {
          logger.warn({ conversationId: conversation.id }, "No messages found for conversation")
          continue
        }

        // Get pre-formatted messages from Phase 1 (formatted with database access)
        const formattedMessages = fetchedData.formattedConversations.get(item.itemId)
        if (!formattedMessages) {
          logger.warn({ conversationId: conversation.id }, "No formatted messages found")
          continue
        }

        const existingMemos = fetchedData.existingConversationMemos.get(item.itemId) ?? []

        // First user message author's timezone, used to anchor relative dates in
        // memos and to render existing-memo timestamps for the classifier.
        const firstUserMsg = messagesArray.find((m) => m.authorType === "user")
        const authorTimezone = firstUserMsg
          ? (fetchedData.authorTimezones.get(firstUserMsg.authorId) ?? undefined)
          : undefined

        // AI call (no connection held)
        const classification = await this.classifier.classifyConversation(
          conversation,
          formattedMessages,
          existingMemos,
          { workspaceId, authorTimezone }
        )

        if (!classification.isKnowledgeWorthy) {
          continue
        }

        if (classification.confidence != null && classification.confidence < MEMO_GEM_CONFIDENCE_FLOOR) {
          logger.info(
            {
              conversationId: conversation.id,
              confidence: classification.confidence,
              threshold: MEMO_GEM_CONFIDENCE_FLOOR,
            },
            "Conversation skipped due to low classifier confidence"
          )
          continue
        }

        // Existing memos that the classifier judged unchanged: leave them as-is.
        if (existingMemos.length > 0 && !classification.shouldReviseExisting) {
          continue
        }

        const isRevision = existingMemos.length > 0

        // A conversation yields a set of single-topic memos. On revision the
        // memorizer sees the existing memos and emits only what is new or changed,
        // optionally linking a memo to the one it continues (non-destructive — the
        // linked memo stays active; supersession is a later read-time/agent call).
        const contents = isRevision
          ? await this.memorizer.reviseMemo(formattedMessages, {
              memoryContext,
              content: messagesArray,
              existingMemos,
              existingTags: fetchedData.existingTags,
              workspaceId,
              authorTimezone,
            })
          : await this.memorizer.memorizeConversation(formattedMessages, {
              memoryContext,
              content: messagesArray,
              existingTags: fetchedData.existingTags,
              workspaceId,
              authorTimezone,
            })

        if (contents.length === 0) {
          logger.info({ conversationId: conversation.id, isRevision }, "Memorizer returned no memos")
          continue
        }

        // Embed all abstracts in one batched call rather than per memo (INV-35/37).
        const embeddings = await this.embeddingService.embedBatch(
          contents.map((c) => c.abstract),
          { workspaceId, functionId: "memo-embedding" }
        )

        for (let i = 0; i < contents.length; i++) {
          const content = contents[i]
          // A linked memo continues an existing one: carry its version forward so the
          // chain reads as a progression, even though both stay active.
          const parent = content.parentMemoId ? existingMemos.find((m) => m.id === content.parentMemoId) : undefined

          const memo: MemoToCreate = {
            id: memoId(),
            workspaceId,
            memoType: MemoTypes.CONVERSATION,
            sourceConversationId: conversation.id,
            title: content.title,
            abstract: content.abstract,
            keyPoints: content.keyPoints,
            sourceMessageIds: content.sourceMessageIds,
            participantIds: conversation.participantIds,
            knowledgeType: content.knowledgeType,
            tags: content.tags,
            status: MemoStatuses.ACTIVE,
            version: parent ? parent.version + 1 : undefined,
            parentMemoId: parent?.id,
            embedding: embeddings[i],
          }

          memosToCreate.push(memo)
          outboxEvents.push({
            eventType: "memo:created",
            payload: {
              workspaceId,
              memoId: memo.id,
              memo: this.toWireMemoFromData(memo),
            },
          })
          memosCreated++
          if (parent) memosLinked++
        }

        logger.info(
          { conversationId: conversation.id, isRevision, memoCount: contents.length },
          "Conversation memos generated"
        )
      } catch (error) {
        itemsFailed++
        logger.error(
          { error, conversationId: item.itemId, workspaceId, streamId },
          "Failed to process conversation for memo"
        )
      }
    }

    if (itemsFailed > 0) {
      logger.warn(
        { workspaceId, streamId, itemsFailed, totalItems: fetchedData.pending.length },
        "Some items failed during memo batch processing"
      )
    }

    // Phase 3: Save all results in ONE transaction (fast, ~200ms instead of 10-50 seconds)
    await withTransaction(this.pool, async (client) => {
      // Insert all memos
      for (const memoData of memosToCreate) {
        const { embedding, ...memoFields } = memoData
        await MemoRepository.insert(client, memoFields)
        await MemoRepository.updateEmbedding(client, memoData.id, embedding)
      }

      // Insert all outbox events
      for (const event of outboxEvents) {
        await OutboxRepository.insert(client, event.eventType, event.payload)
      }

      // Mark processed items (excluding deferred ones that need retry).
      // Deferred items stay unprocessed and are retried on the next batch check
      // cycle (~30s quiet interval, not 5-min cap) since last_activity_at is
      // already older than the quiet threshold.
      const itemsToMark = fetchedData.pending.filter((p) => !deferredItemIds.has(p.id))
      if (itemsToMark.length > 0) {
        await PendingItemRepository.markProcessed(
          client,
          itemsToMark.map((p) => p.id)
        )
      }

      await StreamStateRepository.markProcessed(client, workspaceId, streamId)
    })

    const processed = fetchedData.pending.length - deferredItemIds.size
    logger.info(
      { workspaceId, streamId, processed, deferred: deferredItemIds.size, memosCreated, memosLinked },
      "Memo batch processed"
    )

    return { processed, memosCreated, memosLinked }
  }

  /** Convert MemoToCreate data to wire format (before DB insert, so use current timestamp) */
  private toWireMemoFromData(memoData: MemoToCreate): import("@threa/types").Memo {
    const now = new Date().toISOString()
    return {
      id: memoData.id,
      workspaceId: memoData.workspaceId,
      memoType: memoData.memoType,
      sourceMessageId: memoData.sourceMessageId ?? null,
      sourceConversationId: memoData.sourceConversationId ?? null,
      title: memoData.title,
      abstract: memoData.abstract,
      keyPoints: memoData.keyPoints,
      sourceMessageIds: memoData.sourceMessageIds,
      participantIds: memoData.participantIds,
      knowledgeType: memoData.knowledgeType,
      tags: memoData.tags,
      parentMemoId: memoData.parentMemoId ?? null,
      status: memoData.status,
      version: memoData.version ?? 1,
      revisionReason: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    }
  }
}
