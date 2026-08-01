import type { Pool, PoolClient } from "pg"
import { withTransaction, withClient, type Querier } from "../../db"
import { StreamStateRepository, StreamEventRepository, StreamRepository, type Stream } from "../streams"
import { ConversationRepository } from "../conversations"
import { MessageRepository, type Message } from "../messaging"
import { enrichMessagesWithLinkPreviews } from "../link-previews"
import { OutboxRepository } from "../../lib/outbox"
import { UserRepository } from "../workspaces"
import { WorkspaceSettingsRepository } from "../workspace-settings"
import { StreamContextRepository, contextSnippet, type NewStreamContextItem } from "../stream-context"
import { MemoRepository, type Memo } from "./repository"
import { PendingItemRepository, type PendingMemoItem } from "./pending-item-repository"
import { classificationFingerprint } from "./classification-fingerprint"
import { MemoClassifier } from "./classifier"
import { Memorizer } from "./memorizer"
import { MessageFormatter } from "../../lib/ai/message-formatter"
import type { EmbeddingServiceLike } from "./embedding-service"
import { memoId, eventId, streamContextItemId } from "../../lib/id"
import { logger } from "../../lib/logger"
import {
  MemoTypes,
  MemoStatuses,
  MemoScopes,
  StreamTypes,
  Visibilities,
  AuthorTypes,
  AuthoredByKinds,
  ConversationStatuses,
  type KnowledgeType,
  type MemoScope,
  type MemosCapturedEventPayload,
} from "@threa/types"
import {
  MEMO_GEM_CONFIDENCE_FLOOR,
  MEMO_SINGLE_MESSAGE_AGE_GATE_MS,
  MEMO_ACTIVE_CONVERSATION_QUIET_MS,
  MEMO_DEDUP_DISTANCE,
  MEMO_SUPERSEDE_DISTANCE,
  MEMO_REFLECTIVE_MAX_MEMOS,
  MEMO_REFLECTIVE_KNOWLEDGE_TYPES,
  MEMO_REFLECTIVE_FALLBACK_KNOWLEDGE_TYPE,
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

/**
 * Visibility tier for memos the passive pipeline extracts from `stream` (roadmap
 * 6.4). A private scratchpad is the solo-first "about you" surface — a single
 * unambiguous owner (`created_by`), so its knowledge is that user's private tier.
 * Everything else (channels, public scratchpads, and DMs — two participants with
 * no single owner) stays `workspace`-scoped and is gated by stream access
 * (INV-62); `save_memo` can still opt an individual memo into `user` scope.
 */
function resolveExtractedMemoScope(stream: Stream | null): { scope: MemoScope; scopeUserId: string | null } {
  if (stream && stream.type === StreamTypes.SCRATCHPAD && stream.visibility === Visibilities.PRIVATE) {
    return { scope: MemoScopes.USER, scopeUserId: stream.createdBy }
  }
  return { scope: MemoScopes.WORKSPACE, scopeUserId: null }
}

/**
 * Load `streamId`'s effective root (a thread carries no type/visibility of its
 * own — INV-62) and derive the extracted-memo tier from it. `save_memo` and
 * reflective capture bind to `session.streamId`, which can be a thread inside a
 * private scratchpad; resolving to the root first keeps their memos in the
 * owner's private tier instead of silently falling through to `workspace`. The
 * batch path already passes a top-level stream, so this is a no-op there.
 *
 * `rootStreamId` is that same resolved root, returned so callers routing a
 * memo's `memo:created` reach the root's audience rather than whoever happens
 * to have a thread open.
 */
export async function resolveMemoScopeForStreamId(
  db: Querier,
  streamId: string
): Promise<{ scope: MemoScope; scopeUserId: string | null; rootStreamId: string }> {
  const stream = await StreamRepository.findById(db, streamId)
  const root = stream?.rootStreamId ? await StreamRepository.findById(db, stream.rootStreamId) : stream
  return { ...resolveExtractedMemoScope(root), rootStreamId: root?.id ?? streamId }
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
  /** Visibility tier (roadmap 6.4): `user` for a private scratchpad's owner, else `workspace`. */
  scope: import("@threa/types").MemoScope
  /** Owner for `user` scope; null otherwise (DB CHECK enforces the pairing). */
  scopeUserId: string | null
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
  /**
   * The human the agent is serving (roadmap 6.4) — the owner of a `user`-scoped
   * save. Null for system-triggered turns; a `user`-scope request without it
   * falls back to the stream's natural tier (an ownerless `user` memo is
   * impossible per the DB CHECK).
   */
  invokingUserId?: string | null
  /**
   * Explicit visibility override from the tool: `'user'` files the memo in the
   * invoking user's private tier, `'workspace'` shares it. Omitted ⇒ the memo
   * inherits the save stream's natural tier (a private scratchpad → the owner's
   * private tier), matching passive extraction.
   */
  scope?: MemoScope
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

      // The visibility tier for everything extracted this batch depends only on
      // the (top-level) stream — memos from a private scratchpad are the owner's
      // private tier (roadmap 6.4).
      const memoScope = await resolveMemoScopeForStreamId(client, streamId)

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

      const formattedConversations = new Map<string, string>()

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
        memoScope,
      }
    })

    if (!fetchedData) {
      return { processed: 0, memosCreated: 0 }
    }

    // Format completed preview-card metadata into the same transcript consumed
    // by classification, suggestions, and memorization. Memo accumulation is
    // delayed, so unlike send-time AI consumers it does not need to poll.
    const relativeTo = new Date()
    const allMessageRows = [...fetchedData.conversationMessages.values()].flatMap((messages) =>
      [...messages.values()].filter((message): message is Message => message !== null)
    )
    const enrichedMessages = await enrichMessagesWithLinkPreviews(this.pool, workspaceId, allMessageRows)
    const enrichedById = new Map(enrichedMessages.map((message) => [message.id, message]))

    for (const [conversationId, messages] of fetchedData.conversationMessages) {
      const messageRows = [...messages.values()]
        .filter((message): message is Message => message !== null)
        .map((message) => enrichedById.get(message.id) ?? message)
      if (messageRows.length === 0) continue
      const formatted = await this.messageFormatter.formatMessages(this.pool, workspaceId, messageRows, {
        includeIds: true,
        relativeTo,
      })
      fetchedData.formattedConversations.set(conversationId, formatted)
    }

    const memoryContext = fetchedData.existingMemos.map((m) => m.abstract)
    const memosToCreate: MemoToCreate[] = []
    const deferredItemIds = new Set<string>()
    const classifiedFingerprints: Array<{ id: string; fingerprint: string }> = []
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

        // Nothing the classifier is shown has moved since the last pass, so it
        // would be asked an identical question. The accumulator re-queues on
        // every `conversation:updated`, including completeness and summary
        // changes that carry no new content.
        const fingerprint = classificationFingerprint(conversation, messagesArray, existingMemos)
        if (item.classifiedFingerprint === fingerprint) {
          logger.debug(
            { conversationId: conversation.id },
            "Conversation unchanged since last classification — skipping"
          )
          continue
        }

        // First user message author's timezone, used to anchor relative dates in
        // memos and to render existing-memo timestamps for the classifier.
        const firstUserMsg = messagesArray.find((m) => m.authorType === "user")
        const authorTimezone = firstUserMsg
          ? (fetchedData.authorTimezones.get(firstUserMsg.authorId) ?? undefined)
          : undefined

        classifiedFingerprints.push({ id: item.id, fingerprint })

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
              conversationId: conversation.id,
              authorTimezone,
              memoLanguage: fetchedData.memoLanguage,
            })
          : await this.memorizer.memorizeConversation(formattedMessages, {
              memoryContext,
              content: messagesArray,
              existingTags: fetchedData.existingTags,
              workspaceId,
              conversationId: conversation.id,
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
            scope: fetchedData.memoScope.scope,
            scopeUserId: fetchedData.memoScope.scopeUserId,
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
          scope: memoData.scope,
          scopeUserId: memoData.scopeUserId,
        })
        if (duplicate && !explicitSupersedeIds.includes(duplicate.memo.id)) {
          // The reversed memos still retire even though the correction itself
          // is redundant — the duplicate already carries the corrected
          // knowledge, so dropping the insert loses nothing, but leaving the
          // cited memos active would keep a contradiction standing.
          if (explicitSupersedeIds.length > 0) {
            await MemoRepository.markSuperseded(
              client,
              workspaceId,
              explicitSupersedeIds,
              `Conclusion reversed; corrected knowledge already captured by ${duplicate.memo.id}`
            )
          }
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
          streamId: fetchedData.memoScope.rootStreamId,
          memoId: memoData.id,
          ...(memoData.scopeUserId ? { scopeUserId: memoData.scopeUserId } : {}),
        })
        createdMemos.push(memoData)
      }
      memosCreated = createdMemos.length

      await this.indexCapturedMemos(client, workspaceId, streamId, createdMemos)

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
      // Written before markProcessed so a conversation that reached the model
      // this pass can be recognised as unchanged on the next one.
      await PendingItemRepository.recordClassifiedFingerprints(client, classifiedFingerprints)

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
   * "In this stream" projection rows for freshly captured memos. The landmark
   * sits at the LATEST source message's `created_at`, not the capture time —
   * extraction is debounced, so capture time lands minutes late. Sealed streams
   * are never indexed.
   */
  private async indexCapturedMemos(
    client: PoolClient,
    workspaceId: string,
    streamId: string,
    memos: Array<Pick<MemoToCreate, "id" | "title" | "knowledgeType" | "sourceMessageIds">>
  ): Promise<void> {
    if (memos.length === 0) return
    const stream = await StreamRepository.findById(client, streamId)
    if (!stream) {
      logger.warn({ workspaceId, streamId }, "Memo capture: stream row missing, skipping context landmarks")
      return
    }
    if (stream.e2eEnabled === true) return

    // Landmarks are filed on the top-level stream, never on a thread: save_memo
    // and reflective capture bind to the session's stream, which can be a
    // thread, and the identity index includes stream_id — filing the same memo
    // on both a thread and its root would surface it twice.
    const targetStreamId = stream.rootStreamId ?? stream.id

    const allSourceIds = [...new Set(memos.flatMap((memo) => memo.sourceMessageIds))]
    const sourceMessages = await MessageRepository.findByIdsInWorkspace(client, workspaceId, allSourceIds)

    const rows: NewStreamContextItem[] = []
    for (const memo of memos) {
      const resolved = memo.sourceMessageIds
        .map((id) => sourceMessages.get(id))
        .filter((message): message is Message => message !== undefined)
      if (resolved.length === 0) {
        logger.warn({ memoId: memo.id, workspaceId, streamId }, "Memo has no resolvable source message — not indexed")
        continue
      }
      const latest = resolved.reduce((a, b) => (b.createdAt > a.createdAt ? b : a))
      rows.push({
        id: streamContextItemId(),
        workspaceId,
        streamId: targetStreamId,
        rootStreamId: targetStreamId,
        category: "memo",
        refKind: "memo",
        refId: memo.id,
        groupKey: memo.id,
        // First SURVIVING source, not first cited: a landmark anchored on a
        // deleted message would be unreachable, and the backfill anchors the
        // same way — the two must agree or they write different identity keys.
        sourceMessageId: resolved[0]!.id,
        authorId: latest.authorId,
        occurredAt: latest.createdAt,
        sequence: latest.sequence,
        snippet: contextSnippet(memo.title),
        detail: { title: memo.title, knowledgeType: memo.knowledgeType },
      })
    }
    await StreamContextRepository.insertMany(client, rows)
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
      invokingUserId,
      scope: scopeOverride,
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

      // Resolve the memo's visibility tier (roadmap 6.4). Default to the save
      // stream's natural tier (private scratchpad → the owner's private tier),
      // matching passive extraction; an explicit tool `scope` overrides. A `user`
      // override needs an invoking human to own it — with none, fall back to the
      // natural tier rather than mint an ownerless (CHECK-violating) user memo.
      // Resolves the root so a thread-backed save inherits the scratchpad tier.
      const natural = await resolveMemoScopeForStreamId(client, streamId)
      let resolvedScope = natural.scope
      let resolvedScopeUserId = natural.scopeUserId
      if (scopeOverride === MemoScopes.WORKSPACE) {
        resolvedScope = MemoScopes.WORKSPACE
        resolvedScopeUserId = null
      } else if (scopeOverride === MemoScopes.USER && invokingUserId) {
        resolvedScope = MemoScopes.USER
        resolvedScopeUserId = invokingUserId
      }

      // A `user`-scoped memo is private to one owner, but the `memos:captured`
      // timeline event is a per-stream broadcast to every member (STREAM_SCOPED_EVENTS),
      // carrying the memo title. When save_memo files privately (`user`) into a
      // stream whose audience is WIDER than that owner — i.e. the stream's natural
      // tier isn't itself owner-private — broadcasting would announce the private
      // memo's title to the whole channel, defeating the tier. Suppress the capture
      // event there. Passive/reflective capture never hit this: they only produce
      // `user` scope in a private scratchpad, whose audience already equals the owner.
      const captureLeaksToStream = resolvedScope === MemoScopes.USER && natural.scope !== MemoScopes.USER

      // Serialize against the passive batch and other save_memo calls for this
      // stream (same lock key) so the dedup gate can't be read stale (INV-20).
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`memo-batch:${streamId}`])

      const duplicate = await MemoRepository.findNearDuplicate(client, {
        workspaceId,
        streamId,
        embedding,
        maxDistance: MEMO_DEDUP_DISTANCE,
        scope: resolvedScope,
        scopeUserId: resolvedScopeUserId,
      })
      if (duplicate) {
        logger.info(
          { streamId, existingMemoId: duplicate.memo.id, distance: duplicate.distance },
          "save_memo: knowledge already captured in this stream — returning existing memo"
        )
        return { ok: true, memoId: duplicate.memo.id, title: duplicate.memo.title, deduped: true }
      }

      await MemoRepository.insert(client, {
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
        scope: resolvedScope,
        scopeUserId: resolvedScopeUserId,
      })
      await MemoRepository.updateEmbedding(client, newMemoId, embedding)
      await OutboxRepository.insert(client, "memo:created", {
        workspaceId,
        streamId: natural.rootStreamId,
        memoId: newMemoId,
        ...(resolvedScopeUserId ? { scopeUserId: resolvedScopeUserId } : {}),
      })

      // Visible in situ (INV-62): one broadcast timeline event on the stream the
      // agent saved from, same transaction as the memo row. Carries the source
      // message's own conversation so the board card and the conversation panel
      // can place the row (both match on `conversationId`). Skipped for a private
      // save into a shared stream (would leak the title, see above).
      if (!captureLeaksToStream) {
        const sourceConversation = await ConversationRepository.findPrimaryByMessageId(
          client,
          workspaceId,
          resolvedSourceIds[0]
        )
        const [captureEvent] = await StreamEventRepository.insertMany(client, [
          {
            id: eventId(),
            streamId,
            eventType: "memos:captured" as const,
            payload: {
              ...(sourceConversation ? { conversationId: sourceConversation.id } : {}),
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

        // Same suppression: the projection row denormalizes the memo title into
        // a stream-scoped row every member of that stream can read, so indexing
        // a private memo into a wider stream leaks exactly what the skipped
        // broadcast would have.
        await this.indexCapturedMemos(client, workspaceId, streamId, [
          { id: newMemoId, title, knowledgeType, sourceMessageIds: resolvedSourceIds },
        ])
      }

      logger.info({ streamId, memoId: newMemoId, sessionId, scope: resolvedScope }, "save_memo: agent memo created")
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
      // A reflective memo inherits the session stream's visibility tier — research
      // residue in a private scratchpad is the owner's private tier (roadmap 6.4),
      // consistent with the passive extractor. Resolves the root first so a
      // thread-backed session still inherits the scratchpad tier.
      const memoScope = await resolveMemoScopeForStreamId(client, streamId)
      return { existingMemos, existingTags, memoLanguage, memoScope }
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
        streamId,
        authorTimezone,
        memoLanguage: context.memoLanguage,
      })
    )
      .slice(0, MEMO_REFLECTIVE_MAX_MEMOS)
      .map((content) => {
        // Allowlist gate (see MEMO_REFLECTIVE_KNOWLEDGE_TYPES): an agent must
        // not mint decision-authority memos from its own reflection.
        if (MEMO_REFLECTIVE_KNOWLEDGE_TYPES.includes(content.knowledgeType)) {
          return content
        }
        logger.info(
          { sessionId, streamId, title: content.title, knowledgeType: content.knowledgeType },
          "reflective capture — disallowed knowledge type coerced"
        )
        return { ...content, knowledgeType: MEMO_REFLECTIVE_FALLBACK_KNOWLEDGE_TYPE }
      })
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
          scope: context.memoScope.scope,
          scopeUserId: context.memoScope.scopeUserId,
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
        await MemoRepository.insert(client, {
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
          scope: context.memoScope.scope,
          scopeUserId: context.memoScope.scopeUserId,
        })
        await MemoRepository.updateEmbedding(client, newMemoId, embedding)
        await OutboxRepository.insert(client, "memo:created", {
          workspaceId,
          streamId: context.memoScope.rootStreamId,
          memoId: newMemoId,
          ...(context.memoScope.scopeUserId ? { scopeUserId: context.memoScope.scopeUserId } : {}),
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
        // stream, carrying the anchor message's conversation so the row can be
        // placed on the board card and in the conversation panel.
        const anchorConversation = await ConversationRepository.findPrimaryByMessageId(
          client,
          workspaceId,
          anchorMessageId
        )
        const [captureEvent] = await StreamEventRepository.insertMany(client, [
          {
            id: eventId(),
            streamId,
            eventType: "memos:captured" as const,
            payload: {
              ...(anchorConversation ? { conversationId: anchorConversation.id } : {}),
              memos: capturedMemos,
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

        // Same transaction as the event (INV-7): the client derives a memo row
        // from every memos:captured broadcast, so a capture without its
        // projection row leaves a pending row no server page reconciles.
        await this.indexCapturedMemos(
          client,
          workspaceId,
          streamId,
          capturedMemos.map((memo) => ({
            id: memo.memoId,
            title: memo.title,
            knowledgeType: memo.knowledgeType,
            sourceMessageIds: memo.sourceMessageIds,
          }))
        )
      }

      logger.info(
        { sessionId, streamId, captured: capturedMemos.length, deduped },
        "reflective session capture complete"
      )
      return { classified: true, captured: capturedMemos.length, deduped }
    })
  }
}
