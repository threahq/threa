import type { Pool, PoolClient } from "pg"
import { withTransaction, withClient } from "../../db"
import { StreamStateRepository, StreamEventRepository } from "../streams"
import { ConversationRepository } from "../conversations"
import { MessageRepository, type Message } from "../messaging"
import { OutboxRepository } from "../../lib/outbox"
import { UserRepository } from "../workspaces"
import { WorkspaceSettingsRepository } from "../workspace-settings"
import { MemoRepository, type Memo } from "./repository"
import { PendingItemRepository, type PendingMemoItem } from "./pending-item-repository"
import { MemoClassifier } from "./classifier"
import { Memorizer } from "./memorizer"
import { MessageFormatter } from "../../lib/ai/message-formatter"
import type { EmbeddingServiceLike } from "./embedding-service"
import { memoId, eventId } from "../../lib/id"
import { logger } from "../../lib/logger"
import { MemoTypes, MemoStatuses, AuthorTypes, type MemosCapturedEventPayload } from "@threa/types"
import { MEMO_GEM_CONFIDENCE_FLOOR, MEMO_SINGLE_MESSAGE_AGE_GATE_MS, MEMO_DEDUP_DISTANCE } from "./config"

const MEMORY_CONTEXT_LIMIT = 20
const MIN_CONVERSATION_MESSAGES = 1

/** Key with the highest count, or undefined when the map is empty. */
function mostCommon(counts: Map<string, number>): string | undefined {
  let best: string | undefined
  let bestCount = 0
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key
      bestCount = count
    }
  }
  return best
}

/**
 * Resolve a `users.locale` (BCP-47, e.g. "sv-SE") to an English language name
 * ("Swedish") so the memorizer prompt reads "WRITE EVERY MEMO IN Swedish", not
 * "…IN sv-SE". Falls back to the raw value if the runtime can't resolve it.
 */
function localeToLanguageName(locale: string): string {
  const primary = locale.split(/[-_]/)[0]
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(primary) ?? locale
  } catch {
    return locale
  }
}

export interface ProcessResult {
  processed: number
  memosCreated: number
}

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
  embedding: number[]
}

export interface MemoServiceLike {
  processBatch(workspaceId: string, streamId: string): Promise<ProcessResult>
}

/**
 * Optional to-do collector. The memo classifier already reads every settled
 * conversation; when it flags action items we hand the same pre-formatted
 * messages to the collector, so passive to-do capture rides the classifier
 * call at near-zero marginal cost (INV-52 — depend on the capability, not the
 * concrete service).
 */
export interface SuggestionCollectorLike {
  collectForConversation(params: {
    workspaceId: string
    streamId: string
    conversationId: string
    participantIds: string[]
    formattedMessages: string
    authorTimezone?: string
  }): Promise<number>
}

export interface MemoServiceConfig {
  pool: Pool
  classifier: MemoClassifier
  memorizer: Memorizer
  embeddingService: EmbeddingServiceLike
  messageFormatter: MessageFormatter
  /** Optional — when absent, the memo pipeline runs exactly as before. */
  suggestionCollector?: SuggestionCollectorLike
}

export class MemoService implements MemoServiceLike {
  private pool: Pool
  private classifier: MemoClassifier
  private memorizer: Memorizer
  private embeddingService: EmbeddingServiceLike
  private messageFormatter: MessageFormatter
  private suggestionCollector?: SuggestionCollectorLike

  constructor(config: MemoServiceConfig) {
    this.pool = config.pool
    this.classifier = config.classifier
    this.memorizer = config.memorizer
    this.embeddingService = config.embeddingService
    this.messageFormatter = config.messageFormatter
    this.suggestionCollector = config.suggestionCollector
  }

  /**
   * Three-phase fetch / AI / save so no DB connection is held during AI calls,
   * which can take 1-5+ seconds (INV-41).
   *
   * Single-message conversations are deferred (not marked processed) until they are
   * at least MEMO_SINGLE_MESSAGE_AGE_GATE_MS old, giving time for replies to arrive.
   * Deferred streams are retried on the next quiet-interval cycle (cheap no-op, no AI).
   */
  async processBatch(workspaceId: string, streamId: string): Promise<ProcessResult> {
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
      // Formatting requires resolving author names from the database.
      // includeIds: the memorizer and suggestion collector must cite source
      // message ids; without ids in the prompt the model can't reference them and
      // every memo falls back to the whole conversation (mis-attribution).
      const formattedConversations = new Map<string, string>()
      for (const [convId, msgs] of conversationMessages) {
        const messagesArray = Array.from(msgs.values()).filter((m): m is Message => m !== null)
        if (messagesArray.length > 0) {
          const formatted = await this.messageFormatter.formatMessages(client, workspaceId, messagesArray, {
            includeIds: true,
          })
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
      const localeCounts = new Map<string, number>()
      if (authorIds.size > 0) {
        const members = await UserRepository.findByIds(client, workspaceId, Array.from(authorIds))
        for (const member of members) {
          authorTimezones.set(member.id, member.timezone)
          if (member.locale) localeCounts.set(member.locale, (localeCounts.get(member.locale) ?? 0) + 1)
        }
      }

      // Canonical memo language: the workspace admin setting wins; otherwise
      // default to the participants' most common locale so a single-language
      // stream gets consistent memos (and cross-language duplicates can't form).
      const overrides = await WorkspaceSettingsRepository.findOverrides(client, workspaceId)
      const settingLanguage = overrides.find((o) => o.key === "memoLanguage")?.value
      const explicitLanguage =
        typeof settingLanguage === "string" && settingLanguage.trim().length > 0 ? settingLanguage.trim() : undefined
      const fallbackLocale = mostCommon(localeCounts)
      const memoLanguage = explicitLanguage ?? (fallbackLocale ? localeToLanguageName(fallbackLocale) : undefined)

      return {
        pending,
        existingMemos,
        existingTags,
        conversations,
        conversationMessages,
        existingConversationMemos,
        formattedConversations,
        authorTimezones,
        memoLanguage,
      }
    })

    if (!fetchedData) {
      return { processed: 0, memosCreated: 0 }
    }

    const memoryContext = fetchedData.existingMemos.map((m) => m.abstract)
    const memosToCreate: MemoToCreate[] = []
    const deferredItemIds = new Set<string>()
    let memosCreated = 0
    let memosDeduped = 0
    let itemsFailed = 0

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

        // Pre-formatted in Phase 1 while a connection was held (INV-41).
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

        // To-do collection is independent of knowledge-worthiness (a
        // "send me the deck by Friday" chat has action items but no durable
        // knowledge), so it runs before the memo-only early-returns below.
        // Isolated: a collector failure is logged and never breaks memo
        // extraction. The collector owns its own AI call + transaction.
        if (classification.containsActionItems && this.suggestionCollector) {
          try {
            await this.suggestionCollector.collectForConversation({
              workspaceId,
              streamId,
              conversationId: conversation.id,
              participantIds: conversation.participantIds,
              formattedMessages,
              authorTimezone,
            })
          } catch (error) {
            logger.error(
              { error, conversationId: conversation.id, workspaceId, streamId },
              "Saved-suggestion collection failed"
            )
          }
        }

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
        // memorizer sees the existing memos and emits only what is new or changed;
        // existing memos are left untouched (no supersession, no linking yet).
        const contents = isRevision
          ? await this.memorizer.reviseMemo(formattedMessages, {
              memoryContext,
              content: messagesArray,
              existingMemos,
              existingTags: fetchedData.existingTags,
              workspaceId,
              authorTimezone,
              memoLanguage: fetchedData.memoLanguage,
            })
          : await this.memorizer.memorizeConversation(formattedMessages, {
              memoryContext,
              content: messagesArray,
              existingTags: fetchedData.existingTags,
              workspaceId,
              authorTimezone,
              memoLanguage: fetchedData.memoLanguage,
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
        // Fail loudly rather than silently storing an undefined embedding (INV-11).
        if (embeddings.length !== contents.length) {
          throw new Error(
            `Embedding count mismatch for conversation ${conversation.id}: expected ${contents.length}, got ${embeddings.length}`
          )
        }

        for (let i = 0; i < contents.length; i++) {
          const content = contents[i]

          // Build the candidate; the cross-conversation dedup decision happens
          // in the insert transaction under a per-stream lock (see below), where
          // it can see both committed and same-batch rows authoritatively.
          memosToCreate.push({
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
            embedding: embeddings[i],
          })
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

    // Save all results in one transaction so the memo rows, their outbox
    // events, and the memos:captured timeline events commit atomically.
    await withTransaction(this.pool, async (client) => {
      // Serialize batches for this stream so a concurrent batch can't read the
      // dedup gate and insert the same memo in the window before this one
      // commits (INV-20). Transaction-scoped: released on commit/rollback.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`memo-batch:${streamId}`])

      const createdMemos: MemoToCreate[] = []
      for (const memoData of memosToCreate) {
        // Authoritative dedup (INV-20): under the lock this sees committed
        // memos from other batches AND survivors already inserted earlier in
        // this same transaction (uncommitted rows are visible to it), so it
        // subsumes the in-batch check. Same-conversation repeats are gated
        // here too — the revision prompt alone demonstrably re-emits
        // near-identical memos when a conversation is re-processed.
        const duplicate = await MemoRepository.findNearDuplicate(client, {
          workspaceId,
          streamId,
          embedding: memoData.embedding,
          maxDistance: MEMO_DEDUP_DISTANCE,
        })
        if (duplicate) {
          memosDeduped++
          logger.info(
            { conversationId: memoData.sourceConversationId, title: memoData.title },
            "Skipped duplicate memo (knowledge already captured in this stream)"
          )
          continue
        }

        const { embedding, ...memoFields } = memoData
        await MemoRepository.insert(client, memoFields)
        await MemoRepository.updateEmbedding(client, memoData.id, embedding)
        await OutboxRepository.insert(client, "memo:created", {
          workspaceId,
          memoId: memoData.id,
          memo: this.toWireMemoFromData(memoData),
        })
        createdMemos.push(memoData)
      }
      memosCreated = createdMemos.length

      // Memory capture is visible in situ (INV-62): append one broadcast
      // timeline event per conversation that yielded memos, in the same
      // transaction as the memo rows, so memory creation is never silent.
      // Per-stream debouncing means these land just after the conversations
      // they were extracted from. Batched (INV-56): one sequence allocation
      // covers every capture event in the batch.
      const memosByConversation = new Map<string, MemoToCreate[]>()
      for (const memo of createdMemos) {
        if (!memo.sourceConversationId) {
          // Conversation-type memos always carry sourceConversationId; a miss
          // here is a data bug worth surfacing, not silently skipping (INV-11).
          logger.warn(
            { memoId: memo.id, workspaceId, streamId },
            "Memo missing sourceConversationId — skipping capture event"
          )
          continue
        }
        const group = memosByConversation.get(memo.sourceConversationId) ?? []
        group.push(memo)
        memosByConversation.set(memo.sourceConversationId, group)
      }
      if (memosByConversation.size > 0) {
        const captureEvents = await StreamEventRepository.insertMany(
          client,
          Array.from(memosByConversation, ([conversationId, memos]) => ({
            id: eventId(),
            streamId,
            eventType: "memos:captured" as const,
            payload: {
              conversationId,
              memos: memos.map((memo) => ({
                memoId: memo.id,
                title: memo.title,
                knowledgeType: memo.knowledgeType,
                sourceMessageIds: memo.sourceMessageIds,
              })),
            } satisfies MemosCapturedEventPayload,
            actorType: AuthorTypes.SYSTEM,
          }))
        )
        await OutboxRepository.insertMany(
          client,
          captureEvents.map((event) => ({
            eventType: "stream:memos_captured" as const,
            payload: { workspaceId, streamId, event },
          }))
        )
        logger.info(
          { workspaceId, streamId, conversations: memosByConversation.size, captureEvents: captureEvents.length },
          "memos:captured timeline events inserted"
        )
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
      { workspaceId, streamId, processed, deferred: deferredItemIds.size, memosCreated, memosDeduped },
      "Memo batch processed"
    )

    return { processed, memosCreated }
  }

  /** Wire format for a memo not yet inserted, so timestamps are synthesized as now. */
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
      parentMemoId: null,
      status: memoData.status,
      version: 1,
      revisionReason: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    }
  }
}
