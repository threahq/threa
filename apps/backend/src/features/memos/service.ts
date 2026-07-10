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
import {
  MemoTypes,
  MemoStatuses,
  AuthorTypes,
  AuthoredByKinds,
  ConversationStatuses,
  type KnowledgeType,
  type MemosCapturedEventPayload,
  type Memo as WireMemo,
} from "@threa/types"
import {
  MEMO_GEM_CONFIDENCE_FLOOR,
  MEMO_SINGLE_MESSAGE_AGE_GATE_MS,
  MEMO_ACTIVE_CONVERSATION_QUIET_MS,
  MEMO_DEDUP_DISTANCE,
  MEMO_SUPERSEDE_DISTANCE,
  MEMO_REFLECTIVE_MAX_MEMOS,
} from "./config"

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
  /** Set at save time when this memo supersedes a prior capture from its conversation. */
  parentMemoId?: string
  /** Memos the memorizer explicitly retired (reversed/replaced conclusion), pre-validated. */
  supersedesMemoIds?: string[]
}

/**
 * An explicit "remember this" from a persona via the `save_memo` tool (roadmap
 * 6.2). `streamId` is the stream the turn runs in — it scopes dedup and where
 * the capture event lands. `sessionId` is provenance (the writing session), null
 * when a caller writes outside a session. `sourceMessageIds` (≥1) anchors the
 * memo to real messages so it satisfies the `memo_type = 'message'` source
 * constraint and can point back at what the knowledge came from.
 */
export interface SaveMemoParams {
  workspaceId: string
  streamId: string
  sessionId: string | null
  /**
   * The turn's own stream family — the addressed stream and its effective root.
   * `sourceMessageIds` is LLM-supplied, so source messages are resolved scoped to
   * these streams: a cited id outside this family (another workspace, an
   * inaccessible stream, or a *broader* stream than the one the agent is working
   * in) is dropped. This binds the memo's retrieval access — which memos inherit
   * from their source stream (INV-62) — to exactly the stream that produced it,
   * so an agent memo is never visible to a wider audience than the passive
   * pipeline would give the same conversation. Never persisted / folded into
   * `participant_ids` when it fails the scope.
   */
  sourceStreamIds: string[]
  title: string
  abstract: string
  keyPoints: string[]
  tags: string[]
  knowledgeType: KnowledgeType
  sourceMessageIds: string[]
}

/**
 * `deduped: true` means an equivalent memo was already captured in this stream,
 * so `memoId` points at that existing row and nothing new was written — the
 * knowledge is retained either way, and the tool tells the model it's already
 * remembered rather than stacking a near-duplicate.
 */
export type SaveMemoResult =
  | { ok: true; memoId: string; title: string; deduped: boolean }
  | { ok: false; reason: "no_source_messages" }

/**
 * Reflective capture over a completed session's digest (roadmap 6.3). The
 * classifier + memorizer run on the session's tool-work digest + reply (a second
 * caller of the same pipeline, INV-35), and any resulting memos anchor to
 * `anchorMessageId` — the session's own in-stream trigger/reply message — so they
 * stay `memo_type: 'message'` and inherit that stream's retrieval access
 * unchanged (INV-8/INV-62). `authored_by_kind: 'agent'` + `sessionId` mark the
 * provenance. Idempotency is the caller's job (the `reflective_captured_at` CAS).
 */
export interface CaptureSessionReflectionParams {
  workspaceId: string
  streamId: string
  sessionId: string
  /** Labeled session digest (trigger + research findings + replies). */
  digest: string
  /** The session's own real in-stream message the memos anchor to. */
  anchorMessageId: string
  /** Human participants across the session (a memo's `participant_ids`). */
  participantIds: string[]
  authorTimezone?: string
}

/**
 * `classified` is whether the classifier judged the digest knowledge-worthy and
 * confident enough to memorize; when false, nothing was written. `captured` is
 * memos inserted, `deduped` those dropped as near-duplicates of existing stream
 * knowledge — the knowledge is retained either way.
 */
export interface CaptureSessionReflectionResult {
  classified: boolean
  captured: number
  deduped: number
}

export interface MemoServiceLike {
  processBatch(workspaceId: string, streamId: string): Promise<ProcessResult>
  saveMemo(params: SaveMemoParams): Promise<SaveMemoResult>
  captureSessionReflection(params: CaptureSessionReflectionParams): Promise<CaptureSessionReflectionResult>
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
      // Anchor relative ages to one "now" for the whole batch so the classifier
      // and memorizer can weigh durability (live vs. stale content) without
      // reasoning over absolute timestamps.
      const now = new Date()
      const formattedConversations = new Map<string, string>()
      for (const [convId, msgs] of conversationMessages) {
        const messagesArray = Array.from(msgs.values()).filter((m): m is Message => m !== null)
        if (messagesArray.length > 0) {
          const formatted = await this.messageFormatter.formatMessages(client, workspaceId, messagesArray, {
            includeIds: true,
            relativeTo: now,
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

        // Settle gate: an active conversation touched moments ago is mid-flight.
        // Memorizing it snapshots a live debate — each swing of an unsettled
        // decision becomes its own "decision" memo. Defer until the conversation
        // resolves/stalls or goes quiet; the item retries each batch cycle, and
        // resolution queues a fresh item, so settle-time capture is never missed.
        if (conversation.status === ConversationStatuses.ACTIVE) {
          const quietMs = Date.now() - new Date(conversation.lastActivityAt).getTime()
          if (quietMs < MEMO_ACTIVE_CONVERSATION_QUIET_MS) {
            deferredItemIds.add(item.id)
            logger.debug(
              { conversationId: conversation.id, quietMs, threshold: MEMO_ACTIVE_CONVERSATION_QUIET_MS },
              "Deferring active conversation until it settles"
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
            supersedesMemoIds: content.supersedesMemoIds,
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
        const explicitSupersedeIds = (memoData.supersedesMemoIds ?? []).filter(
          (id) => !createdMemos.some((m) => m.id === id)
        )

        // A memo this one explicitly retires is never its dedup blocker: a
        // correction of an inverted conclusion shares nearly all its text with
        // the memo it corrects, so the pair can embed inside the dedup
        // distance — dropping the correction would leave the wrong memo
        // standing (the July 2026 incident shape).
        const duplicate = await MemoRepository.findNearDuplicate(client, {
          workspaceId,
          streamId,
          embedding: memoData.embedding,
          maxDistance: MEMO_DEDUP_DISTANCE,
        })
        if (duplicate && !explicitSupersedeIds.includes(duplicate.memo.id)) {
          memosDeduped++
          logger.info(
            { conversationId: memoData.sourceConversationId, title: memoData.title },
            "Skipped duplicate memo (knowledge already captured in this stream)"
          )
          continue
        }

        // Explicit supersession first: the memorizer names the memos whose
        // conclusion this one reverses or replaces (ids pre-validated against
        // the conversation's own memos). Embedding distance cannot catch a
        // reversal — "chose X" and "chose Y" embed far apart — so the model's
        // citation is authoritative. The embedding check below still runs for
        // unflagged paraphrase re-captures.
        if (explicitSupersedeIds.length > 0) {
          memoData.parentMemoId = explicitSupersedeIds[0]
          await MemoRepository.markSuperseded(
            client,
            workspaceId,
            explicitSupersedeIds,
            `Conclusion reversed or replaced by revised capture ${memoData.id}`
          )
          logger.info(
            {
              conversationId: memoData.sourceConversationId,
              memoId: memoData.id,
              supersededIds: explicitSupersedeIds,
            },
            "Revised memo explicitly superseded reversed prior capture(s)"
          )
        }

        // Same-conversation supersession: a revised capture of a topic
        // replaces the conversation's earlier memo on it (paraphrases in the
        // dedup–supersede band would otherwise stack forever — the observed
        // prod failure). Nearest old memo becomes the parent; all matches are
        // retired. Batch-mates are excluded so two new memos can't supersede
        // each other.
        const toSupersede = memoData.sourceConversationId
          ? await MemoRepository.findSameConversationNear(client, {
              workspaceId,
              conversationId: memoData.sourceConversationId,
              embedding: memoData.embedding,
              maxDistance: MEMO_SUPERSEDE_DISTANCE,
              excludeIds: [...createdMemos.map((m) => m.id), ...explicitSupersedeIds],
            })
          : []
        if (toSupersede.length > 0) {
          memoData.parentMemoId = memoData.parentMemoId ?? toSupersede[0].memo.id
          await MemoRepository.markSuperseded(
            client,
            workspaceId,
            toSupersede.map((s) => s.memo.id),
            `Superseded by revised capture ${memoData.id}`
          )
          logger.info(
            {
              conversationId: memoData.sourceConversationId,
              memoId: memoData.id,
              supersededIds: toSupersede.map((s) => s.memo.id),
            },
            "Revised memo superseded prior capture(s) from the same conversation"
          )
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

  /**
   * Explicit persona memo write (`save_memo`, roadmap 6.2). Reuses the pipeline's
   * embedding + dedup + capture-event machinery (INV-35, no parallel write path):
   * embed the abstract, then in one transaction take the per-stream lock, drop a
   * near-duplicate, insert the memo with `authored_by_kind: 'agent'` + session
   * provenance, and append the `memos:captured` broadcast event (INV-62 — agent
   * writes are visible in situ too). The embed runs before the transaction so no
   * connection is held across the AI call (INV-41).
   */
  async saveMemo(params: SaveMemoParams): Promise<SaveMemoResult> {
    const {
      workspaceId,
      streamId,
      sessionId,
      sourceStreamIds,
      title,
      abstract,
      keyPoints,
      tags,
      knowledgeType,
      sourceMessageIds,
    } = params

    // A message source is required so the row satisfies `memo_type_source`
    // (memo_type 'message' ⇒ source_message_id NOT NULL). The tool enforces ≥1,
    // but guard here too rather than let a constraint violation surface as a 500.
    if (sourceMessageIds.length === 0) {
      return { ok: false, reason: "no_source_messages" }
    }

    const [embedding] = await this.embeddingService.embedBatch([abstract], {
      workspaceId,
      functionId: "memo-embedding",
    })
    if (!embedding) {
      // Fail loudly rather than store a memo with no embedding (INV-11) — it
      // would be invisible to semantic retrieval.
      throw new Error(`Embedding failed for save_memo in stream ${streamId}`)
    }

    const newMemoId = memoId()

    return withTransaction(this.pool, async (client) => {
      // Resolve the cited source messages scoped to the turn's own stream family
      // (INV-8/INV-62): `sourceMessageIds` is LLM-supplied, so an id outside this
      // family — another workspace, an inaccessible stream, or a broader stream
      // than the one the agent is working in — must never be persisted as
      // `source_message_id` (it would widen the memo's inherited retrieval access
      // beyond the producing stream) or fold its author into `participant_ids`.
      // Only the ids that resolve within the family survive.
      const sourceMessages = await MessageRepository.findByIdsInStreams(
        client,
        workspaceId,
        sourceMessageIds,
        sourceStreamIds
      )
      const resolvedSourceIds = sourceMessageIds.filter((id) => sourceMessages.has(id))
      if (resolvedSourceIds.length === 0) {
        // No cited id belongs to the turn's stream — no valid anchor, so don't
        // invent one (would violate the CHECK / mis-scope the memo).
        logger.info({ streamId, sourceMessageIds }, "save_memo: no in-stream source messages — rejecting")
        return { ok: false, reason: "no_source_messages" }
      }
      const participantIds = Array.from(
        new Set(
          resolvedSourceIds
            .map((id) => sourceMessages.get(id))
            .filter((m): m is Message => m !== undefined && m.authorType === AuthorTypes.USER)
            .map((m) => m.authorId)
        )
      )

      // Serialize against the passive batch and other save_memo calls for this
      // stream (same lock key) so the dedup gate can't be read stale (INV-20).
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`memo-batch:${streamId}`])

      const duplicate = await MemoRepository.findNearDuplicate(client, {
        workspaceId,
        streamId,
        embedding,
        maxDistance: MEMO_DEDUP_DISTANCE,
      })
      if (duplicate) {
        logger.info(
          { streamId, existingMemoId: duplicate.memo.id, distance: duplicate.distance },
          "save_memo: knowledge already captured in this stream — returning existing memo"
        )
        return { ok: true, memoId: duplicate.memo.id, title: duplicate.memo.title, deduped: true }
      }

      const inserted = await MemoRepository.insert(client, {
        id: newMemoId,
        workspaceId,
        memoType: MemoTypes.MESSAGE,
        sourceMessageId: resolvedSourceIds[0],
        title,
        abstract,
        keyPoints,
        sourceMessageIds: resolvedSourceIds,
        participantIds,
        knowledgeType,
        tags,
        status: MemoStatuses.ACTIVE,
        authoredByKind: AuthoredByKinds.AGENT,
        sourceSessionId: sessionId ?? undefined,
      })
      await MemoRepository.updateEmbedding(client, newMemoId, embedding)
      await OutboxRepository.insert(client, "memo:created", {
        workspaceId,
        memoId: newMemoId,
        memo: this.toWireMemo(inserted),
      })

      // Visible in situ (INV-62): one broadcast timeline event on the stream the
      // agent saved from, same transaction as the memo row. Message-sourced, so
      // no conversationId — the row links back through sourceMessageIds.
      const [captureEvent] = await StreamEventRepository.insertMany(client, [
        {
          id: eventId(),
          streamId,
          eventType: "memos:captured" as const,
          payload: {
            memos: [{ memoId: newMemoId, title, knowledgeType, sourceMessageIds: resolvedSourceIds }],
          } satisfies MemosCapturedEventPayload,
          actorType: AuthorTypes.SYSTEM,
        },
      ])
      await OutboxRepository.insertMany(client, [
        {
          eventType: "stream:memos_captured" as const,
          payload: { workspaceId, streamId, event: captureEvent },
        },
      ])

      logger.info({ streamId, memoId: newMemoId, sessionId }, "save_memo: agent memo created")
      return { ok: true, memoId: newMemoId, title, deduped: false }
    })
  }

  /**
   * Distil a completed session's digest into ≤{@link MEMO_REFLECTIVE_MAX_MEMOS}
   * agent memos (roadmap 6.3). Same three-phase shape as the batch (read context /
   * AI / save) so no connection is held across the classifier, memorizer, or
   * embed calls (INV-41). Reuses the classifier + memorizer + dedup + capture
   * machinery — a second caller, not a second pipeline (INV-35). The memos anchor
   * to the session's own in-stream message, so they are message-sourced and their
   * retrieval access is exactly the producing stream's (INV-8/INV-62), never wider.
   */
  async captureSessionReflection(params: CaptureSessionReflectionParams): Promise<CaptureSessionReflectionResult> {
    const { workspaceId, streamId, sessionId, digest, anchorMessageId, participantIds, authorTimezone } = params
    const none = { classified: false, captured: 0, deduped: 0 }

    // Phase 1: read the stream's memo context (single connection, no AI held).
    const context = await withClient(this.pool, async (client) => {
      const existingMemos = await MemoRepository.findByStream(client, streamId, {
        status: MemoStatuses.ACTIVE,
        limit: MEMORY_CONTEXT_LIMIT,
        orderBy: "createdAt",
      })
      const existingTags = await MemoRepository.getAllTags(client, workspaceId)
      // Only the explicit workspace setting is honored here (no participant-locale
      // fallback): a session's participants are usually just the invoking user, too
      // thin a sample to infer a canonical language from.
      const overrides = await WorkspaceSettingsRepository.findOverrides(client, workspaceId)
      const settingLanguage = overrides.find((o) => o.key === "memoLanguage")?.value
      const memoLanguage =
        typeof settingLanguage === "string" && settingLanguage.trim().length > 0 ? settingLanguage.trim() : undefined
      return { existingMemos, existingTags, memoLanguage }
    })

    // Phase 2: classify the digest. topicSummary is null — the digest's own
    // "Trigger / researched / replied" sections carry the framing, and a session
    // has no conversation topic.
    const classification = await this.classifier.classifyConversation(
      { id: sessionId, topicSummary: null, participantIds },
      digest,
      context.existingMemos,
      { workspaceId, authorTimezone }
    )
    if (!classification.isKnowledgeWorthy) return none
    if (classification.confidence != null && classification.confidence < MEMO_GEM_CONFIDENCE_FLOOR) {
      logger.info(
        { sessionId, streamId, confidence: classification.confidence, threshold: MEMO_GEM_CONFIDENCE_FLOOR },
        "reflective capture skipped — low classifier confidence"
      )
      return none
    }

    // Phase 3: memorize. `content: []` — a reflective memo's source is the session
    // anchor, not the digest's cited message ids, so no per-message resolution.
    const contents = (
      await this.memorizer.memorizeConversation(digest, {
        memoryContext: context.existingMemos.map((m) => m.abstract),
        content: [],
        existingTags: context.existingTags,
        workspaceId,
        authorTimezone,
        memoLanguage: context.memoLanguage,
      })
    ).slice(0, MEMO_REFLECTIVE_MAX_MEMOS)
    if (contents.length === 0) {
      logger.info({ sessionId, streamId }, "reflective capture — memorizer returned no memos")
      return { classified: true, captured: 0, deduped: 0 }
    }

    const embeddings = await this.embeddingService.embedBatch(
      contents.map((c) => c.abstract),
      { workspaceId, functionId: "memo-embedding" }
    )
    if (embeddings.length !== contents.length) {
      throw new Error(
        `Embedding count mismatch for reflective capture ${sessionId}: expected ${contents.length}, got ${embeddings.length}`
      )
    }

    // Phase 4: save under the same per-stream lock the batch/save_memo use, so
    // the dedup gate can't be read stale (INV-20). Memo rows, their outbox
    // events, and the memos:captured timeline event commit atomically (INV-7/62).
    return withTransaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`memo-batch:${streamId}`])

      const capturedMemos: MemosCapturedEventPayload["memos"] = []
      let deduped = 0
      for (let i = 0; i < contents.length; i++) {
        const content = contents[i]
        const embedding = embeddings[i]

        // Dedup against committed stream memos AND survivors inserted earlier in
        // this transaction (a second near-identical reflective memo is dropped).
        const duplicate = await MemoRepository.findNearDuplicate(client, {
          workspaceId,
          streamId,
          embedding,
          maxDistance: MEMO_DEDUP_DISTANCE,
        })
        if (duplicate) {
          deduped++
          logger.info(
            { sessionId, streamId, existingMemoId: duplicate.memo.id, distance: duplicate.distance },
            "reflective capture — knowledge already captured in this stream"
          )
          continue
        }

        const newMemoId = memoId()
        const inserted = await MemoRepository.insert(client, {
          id: newMemoId,
          workspaceId,
          memoType: MemoTypes.MESSAGE,
          sourceMessageId: anchorMessageId,
          title: content.title,
          abstract: content.abstract,
          keyPoints: content.keyPoints,
          sourceMessageIds: [anchorMessageId],
          participantIds,
          knowledgeType: content.knowledgeType,
          tags: content.tags,
          status: MemoStatuses.ACTIVE,
          authoredByKind: AuthoredByKinds.AGENT,
          sourceSessionId: sessionId,
        })
        await MemoRepository.updateEmbedding(client, newMemoId, embedding)
        await OutboxRepository.insert(client, "memo:created", {
          workspaceId,
          memoId: newMemoId,
          memo: this.toWireMemo(inserted),
        })
        capturedMemos.push({
          memoId: newMemoId,
          title: content.title,
          knowledgeType: content.knowledgeType,
          sourceMessageIds: [anchorMessageId],
        })
      }

      if (capturedMemos.length > 0) {
        // Visible in situ (INV-62): one broadcast timeline event on the session's
        // stream. Message-sourced, so no conversationId — links via sourceMessageIds.
        const [captureEvent] = await StreamEventRepository.insertMany(client, [
          {
            id: eventId(),
            streamId,
            eventType: "memos:captured" as const,
            payload: { memos: capturedMemos } satisfies MemosCapturedEventPayload,
            actorType: AuthorTypes.SYSTEM,
          },
        ])
        await OutboxRepository.insertMany(client, [
          {
            eventType: "stream:memos_captured" as const,
            payload: { workspaceId, streamId, event: captureEvent },
          },
        ])
      }

      logger.info(
        { sessionId, streamId, captured: capturedMemos.length, deduped },
        "reflective session capture complete"
      )
      return { classified: true, captured: capturedMemos.length, deduped }
    })
  }

  /** Wire format for a persisted memo row (repository `Memo` → `@threa/types` `Memo`). */
  private toWireMemo(memo: Memo): WireMemo {
    return {
      id: memo.id,
      workspaceId: memo.workspaceId,
      memoType: memo.memoType,
      sourceMessageId: memo.sourceMessageId,
      sourceConversationId: memo.sourceConversationId,
      title: memo.title,
      abstract: memo.abstract,
      keyPoints: memo.keyPoints,
      sourceMessageIds: memo.sourceMessageIds,
      participantIds: memo.participantIds,
      knowledgeType: memo.knowledgeType,
      tags: memo.tags,
      parentMemoId: memo.parentMemoId,
      status: memo.status,
      version: memo.version,
      revisionReason: memo.revisionReason,
      createdAt: memo.createdAt.toISOString(),
      updatedAt: memo.updatedAt.toISOString(),
      archivedAt: memo.archivedAt ? memo.archivedAt.toISOString() : null,
    }
  }

  /** Wire format for a memo not yet inserted, so timestamps are synthesized as now. */
  private toWireMemoFromData(memoData: MemoToCreate): WireMemo {
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
      version: 1,
      revisionReason: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    }
  }
}
