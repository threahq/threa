import type { Pool, PoolClient } from "pg"
import { ulid } from "ulid"
import { AISpendDeniedError } from "@threahq/agent-runtime"
import type { AnalyticsReporter } from "@threahq/backend-common"
import { withTransaction, withClient, type Querier } from "../../db"
import {
  assertStreamWritable,
  findMemoryModeStream,
  isMemoryAutomationOn,
  StreamStateRepository,
  StreamEventRepository,
  StreamRepository,
  type Stream,
  type StreamWritePrincipal,
} from "../streams"
import { ConversationRepository } from "../conversations"
import { findSharedTree, viewAsPartner } from "../stream-connections"
import { MessageRepository, type Message } from "../messaging"
import { enrichMessagesWithLinkPreviews } from "../link-previews"
import { OutboxRepository } from "../../lib/outbox"
import { UserRepository } from "../workspaces"
import { WorkspaceSettingsRepository } from "../workspace-settings"
import type { MemoAudience } from "./audience"
import { MemoRepository, type Memo } from "./repository"
import { publishSharedMemoChanges } from "./embed-summaries"
import { indexCapturedMemos, recordConversationCaptures } from "./captures"
import { PendingItemRepository, type PendingMemoItem } from "./pending-item-repository"
import { classificationFingerprint } from "./classification-fingerprint"
import type { ConversationClassifier } from "./classifier"
import { Memorizer } from "./memorizer"
import { MessageFormatter } from "../../lib/ai/message-formatter"
import type { EmbeddingServiceLike } from "./embedding-service"
import { memoId, eventId } from "../../lib/id"
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
} from "@threahq/types"
import {
  MEMO_GEM_CONFIDENCE_FLOOR,
  MEMO_SINGLE_MESSAGE_AGE_GATE_MS,
  MEMO_ACTIVE_CONVERSATION_QUIET_MS,
  MEMO_MAX_FAILED_ATTEMPTS,
  MEMO_BATCH_CLAIM_SECONDS,
  MEMO_DEDUP_DISTANCE,
  MEMO_SUPERSEDE_DISTANCE,
  MEMO_REFLECTIVE_MAX_MEMOS,
  MEMO_REFLECTIVE_KNOWLEDGE_TYPES,
  MEMO_REFLECTIVE_FALLBACK_KNOWLEDGE_TYPE,
} from "./config"

const MEMORY_CONTEXT_LIMIT = 20
const MEMORY_CONTEXT_NEAREST_LIMIT = 10
const MEMORY_CONTEXT_EMBED_MAX_CHARS = 8000
const MIN_CONVERSATION_MESSAGES = 1

export const MEMO_CAPTURE_OUTCOME_EVENT = "memo_capture_outcome"

/** One per classified conversation; the capture rate is `memorized` over all of them. */
type CaptureOutcome = "memorized" | "not_worthy" | "low_confidence" | "unchanged" | "empty" | "failed"

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
  if (
    stream &&
    (stream.type === StreamTypes.ASIDE ||
      (stream.type === StreamTypes.SCRATCHPAD && stream.visibility === Visibilities.PRIVATE))
  ) {
    return { scope: MemoScopes.USER, scopeUserId: stream.createdBy }
  }
  return { scope: MemoScopes.WORKSPACE, scopeUserId: null }
}

/**
 * Who reads what the memorizer extracts from a stream. A user-scoped memo is read by its
 * owner alone, so the owner's own agent memos citing their private streams stay in view;
 * anything else is read by the whole room and sees only what the room reads.
 */
function memorizerAudience(memoScope: {
  scope: MemoScope
  scopeUserId: string | null
  rootStreamId: string
}): MemoAudience {
  return memoScope.scope === MemoScopes.USER && memoScope.scopeUserId
    ? { kind: "users", userIds: [memoScope.scopeUserId] }
    : { kind: "room", roomStreamId: memoScope.rootStreamId }
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
  workspaceId: string,
  streamId: string
): Promise<{ scope: MemoScope; scopeUserId: string | null; rootStreamId: string }> {
  const stream = await StreamRepository.findById(db, workspaceId, streamId)
  const root = stream?.rootStreamId ? await StreamRepository.findById(db, workspaceId, stream.rootStreamId) : stream
  return { ...resolveExtractedMemoScope(root), rootStreamId: root?.id ?? streamId }
}

export interface ProcessResult {
  processed: number
  memosCreated: number
}

interface MemoToCreate {
  id: string
  workspaceId: string
  memoType: import("@threahq/types").MemoType
  sourceMessageId?: string
  sourceConversationId?: string
  title: string
  abstract: string
  keyPoints: string[]
  sourceMessageIds: string[]
  participantIds: string[]
  knowledgeType: import("@threahq/types").KnowledgeType
  tags: string[]
  status: import("@threahq/types").MemoStatus
  embedding: number[]
  /** Visibility tier (roadmap 6.4): `user` for a private scratchpad's owner, else `workspace`. */
  scope: import("@threahq/types").MemoScope
  /** Owner for `user` scope; null otherwise (DB CHECK enforces the pairing). */
  scopeUserId: string | null
  sharedRootStreamId?: string
  /** Set at save time when this memo supersedes a prior capture from its conversation. */
  parentMemoId?: string
  /** Memos the memorizer explicitly retired (reversed/replaced conclusion), pre-validated. */
  supersedesMemoIds?: string[]
  /** Inherited from the memos this one retires when any of them reached fewer readers than its location. */
  sourceStreamIds?: string[]
  requiresBrowse?: boolean
}

/**
 * A revision may carry what the memos it retires said, so it reaches no reader they were hidden from:
 * once any of them is agent-written or has sources, it takes their sources plus its own stream, and
 * needs browse when any of them did (a legacy agent memo without sources always does).
 */
function inheritedReach(
  retired: readonly Memo[],
  streamId: string
): Pick<MemoToCreate, "sourceStreamIds" | "requiresBrowse"> {
  const hasSources = (memo: Memo) => (memo.sourceStreamIds?.length ?? 0) > 0
  const isAgent = (memo: Memo) => memo.authoredByKind === AuthoredByKinds.AGENT
  if (!retired.some((memo) => isAgent(memo) || hasSources(memo))) return {}
  return {
    sourceStreamIds: [...new Set([streamId, ...retired.flatMap((memo) => memo.sourceStreamIds ?? [])])],
    requiresBrowse: retired.some((memo) => memo.requiresBrowse || (isAgent(memo) && !hasSources(memo))),
  }
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
  /**
   * Streams whose content reached the model this turn beyond the turn's own
   * family. Stored on the memo with the family so a reader needs access to all
   * of them; a superset only narrows the audience, a subset leaks.
   */
  provenanceStreamIds: string[]
  /** Who the agent wrote for; only memos it reads count as duplicates. Null when unresolved: then only memos the room reads do. */
  audience: MemoAudience | null
  /** The turn's audience browsed the workspace, so member-only content may have reached the model: readers who cannot browse never see the memo. */
  requiresBrowse: boolean
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
  | { ok: true; memoId: string; title: string; deduped: boolean; scope: MemoScope }
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
  /** Streams the session's research cited. */
  citedStreamIds: string[]
  /** Messages the session's research cited; those in the session's root become memo sources after the anchor. */
  citedMessageIds: string[]
  /** The session ran for readers who browse the workspace, so its digest may hold member-only content: readers who cannot browse never see the memos. */
  requiresBrowse: boolean
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
  saveMemoGenerated(principal: StreamWritePrincipal, params: SaveMemoParams): Promise<SaveMemoResult>
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
  classifier: ConversationClassifier
  memorizer: Memorizer
  embeddingService: EmbeddingServiceLike
  messageFormatter: MessageFormatter
  /** Optional — when absent, the memo pipeline runs exactly as before. */
  suggestionCollector?: SuggestionCollectorLike
  analyticsReporter: AnalyticsReporter
}

export class MemoService implements MemoServiceLike {
  private pool: Pool
  private classifier: ConversationClassifier
  private memorizer: Memorizer
  private embeddingService: EmbeddingServiceLike
  private messageFormatter: MessageFormatter
  private suggestionCollector?: SuggestionCollectorLike
  private analyticsReporter: AnalyticsReporter

  constructor(config: MemoServiceConfig) {
    this.pool = config.pool
    this.classifier = config.classifier
    this.memorizer = config.memorizer
    this.embeddingService = config.embeddingService
    this.messageFormatter = config.messageFormatter
    this.suggestionCollector = config.suggestionCollector
    this.analyticsReporter = config.analyticsReporter
  }

  /**
   * Counted as a PostHog service event grouped by workspace, with no person
   * profile and no content, so it holds for users who denied analytics.
   */
  private recordCaptureOutcome(
    ids: { workspaceId: string; streamId: string; conversationId: string },
    outcome: CaptureOutcome,
    extra?: { memoCount?: number; isRevision?: boolean; confidence?: number }
  ): void {
    logger.info({ ...ids, outcome, ...extra }, "Memo capture outcome")
    this.analyticsReporter.captureEvent({
      distinctId: `workspace:${ids.workspaceId}`,
      event: MEMO_CAPTURE_OUTCOME_EVENT,
      properties: { outcome, ...extra, $process_person_profile: false },
      groups: { workspace: ids.workspaceId },
    })
  }

  /** One batch per stream at a time: a stream another batch holds is skipped. */
  async processBatch(workspaceId: string, streamId: string): Promise<ProcessResult> {
    const claimToken = ulid()
    const claimed = await StreamStateRepository.claimBatch(
      this.pool,
      workspaceId,
      streamId,
      claimToken,
      MEMO_BATCH_CLAIM_SECONDS
    )
    if (!claimed) return { processed: 0, memosCreated: 0 }

    try {
      return await this.runBatch(workspaceId, streamId, claimToken)
    } finally {
      await StreamStateRepository.releaseBatchClaim(this.pool, workspaceId, streamId, claimToken)
    }
  }

  /**
   * Three-phase fetch / AI / save so no DB connection is held during AI calls,
   * which can take 1-5+ seconds (INV-41).
   *
   * Single-message conversations are deferred (not marked processed) until they are
   * at least MEMO_SINGLE_MESSAGE_AGE_GATE_MS old, giving time for replies to arrive.
   * Deferred streams are retried on the next quiet-interval cycle (cheap no-op, no AI).
   */
  private async runBatch(workspaceId: string, streamId: string, claimToken: string): Promise<ProcessResult> {
    const fetchedData = await withClient(this.pool, async (client) => {
      const pending = await PendingItemRepository.findUnprocessed(client, workspaceId, streamId, {
        limit: 50,
      })

      if (pending.length === 0) {
        return null
      }

      // Queued before memory was switched off: dropped, not captured.
      if (!isMemoryAutomationOn(await findMemoryModeStream(client, workspaceId, streamId))) {
        await PendingItemRepository.markProcessed(client, workspaceId, pending)
        return null
      }

      // The visibility tier for everything extracted this batch depends only on
      // the (top-level) stream — memos from a private scratchpad are the owner's
      // private tier (roadmap 6.4). The model sees only memos in that tier.
      const memoScope = await resolveMemoScopeForStreamId(client, workspaceId, streamId)
      // The model is shown, and dedupes against, only memos its readers read.
      const readerAudience = memorizerAudience(memoScope)

      // While the channel is shared, the batch reads it as the partner does and
      // sees only memos made that way, so what it captures can cross with it.
      const sharedTree = await findSharedTree(client, workspaceId, streamId)
      const sharedRootStreamId = sharedTree?.rootStreamId

      const existingMemos = await MemoRepository.findByStream(client, workspaceId, streamId, {
        scopeUserId: memoScope.scopeUserId,
        audiences: [readerAudience],
        status: MemoStatuses.ACTIVE,
        limit: MEMORY_CONTEXT_LIMIT,
        orderBy: "sourceAt",
        sharedRootStreamId,
      })

      const existingTags = await MemoRepository.getAllTags(client, workspaceId, { ...memoScope, sharedRootStreamId })

      const conversationItemIds = pending.filter((p) => p.itemType === "conversation").map((p) => p.itemId)
      const conversations = new Map<string, NonNullable<Awaited<ReturnType<typeof ConversationRepository.findById>>>>()
      const conversationMessages = new Map<string, Map<string, Message | null>>()
      const existingConversationMemos = new Map<string, Memo[]>()
      const unreadable = new Map<string, unknown>()

      for (const convId of conversationItemIds) {
        const conv = await ConversationRepository.findById(client, workspaceId, convId)
        if (conv) {
          conversations.set(convId, conv)
          const msgs = await MessageRepository.findByIds(client, workspaceId, conv.messageIds)
          const live = [...msgs.values()].filter((message) => !message.deletedAt)
          let read: Message[]
          try {
            read = await viewAsPartner(client, workspaceId, sharedTree, live)
          } catch (error) {
            // Fails this conversation alone, through Phase 2's capped retries,
            // rather than stalling every conversation queued for the stream.
            unreadable.set(convId, error)
            continue
          }
          conversationMessages.set(convId, new Map(read.map((message) => [message.id, message])))
          // A saved or reflective memo citing a message edited since is shown
          // beside the conversation's own memos, so the classifier keeps it
          // through a typo fix and a revision can supersede it. Same tier only:
          // a private memo must never feed a shared revision, nor a pre-share one a crossing revision.
          const existingMemos = [
            ...(await MemoRepository.findActiveBySourceConversation(
              client,
              workspaceId,
              convId,
              [readerAudience],
              sharedRootStreamId
            )),
            ...(await MemoRepository.findActiveMessageMemosCitingEdited(
              client,
              workspaceId,
              conv.messageIds,
              memoScope.scopeUserId,
              [readerAudience],
              sharedRootStreamId
            )),
          ]
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
        readerAudience,
        sharedRootStreamId,
        unreadable,
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
    // A shared channel's partner sees no previews; the host fetched them, some with its own integrations.
    const enrichedMessages = fetchedData.sharedRootStreamId
      ? allMessageRows
      : await enrichMessagesWithLinkPreviews(this.pool, workspaceId, allMessageRows)
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

    const memosToCreate: MemoToCreate[] = []
    const deferredItemIds = new Set<string>()
    const failedItemIds = new Set<string>()
    const classifiedFingerprints: Array<{ id: string; fingerprint: string }> = []
    const shownContextMemos = new Map(fetchedData.existingMemos.map((memo) => [memo.id, memo]))
    let memosCreated = 0
    let memosDeduped = 0

    const convItems = fetchedData.pending.filter((p) => p.itemType === "conversation")
    for (const item of convItems) {
      if (
        !(await StreamStateRepository.renewBatchClaim(
          this.pool,
          workspaceId,
          streamId,
          claimToken,
          MEMO_BATCH_CLAIM_SECONDS
        ))
      ) {
        logger.info({ streamId }, "Memo batch lost its stream claim — another batch took over")
        return { processed: 0, memosCreated: 0 }
      }
      try {
        if (fetchedData.unreadable.has(item.itemId)) throw fetchedData.unreadable.get(item.itemId)
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
            if (error instanceof AISpendDeniedError) throw error
            logger.error(
              { error, conversationId: conversation.id, workspaceId, streamId },
              "Saved-suggestion collection failed"
            )
          }
        }

        if (!classification.isKnowledgeWorthy) {
          this.recordCaptureOutcome({ workspaceId, streamId, conversationId: conversation.id }, "not_worthy")
          continue
        }

        if (classification.confidence != null && classification.confidence < MEMO_GEM_CONFIDENCE_FLOOR) {
          this.recordCaptureOutcome({ workspaceId, streamId, conversationId: conversation.id }, "low_confidence", {
            confidence: classification.confidence,
          })
          continue
        }

        // Existing memos that the classifier judged unchanged: leave them as-is.
        if (existingMemos.length > 0 && !classification.shouldReviseExisting) {
          this.recordCaptureOutcome({ workspaceId, streamId, conversationId: conversation.id }, "unchanged")
          continue
        }

        const isRevision = existingMemos.length > 0

        // The memorizer can only retire a memo it is shown, and the stream's
        // newest memos miss an older one this conversation revises. Keeps the
        // tail: a long conversation's latest messages carry the revision.
        // Below the limit the newest memos are every memo, so nothing is missing.
        let nearest: Memo[] = []
        if (fetchedData.existingMemos.length >= MEMORY_CONTEXT_LIMIT) {
          // Attachment-only messages have no text, and embedding rejects an empty input.
          const messageText = messagesArray.map((m) => m.contentMarkdown).join("\n")
          const conversationText = messageText.trim() ? messageText : formattedMessages
          let conversationEmbedding: number[] | undefined
          try {
            ;[conversationEmbedding] = await this.embeddingService.embedBatch(
              [Array.from(conversationText).slice(-MEMORY_CONTEXT_EMBED_MAX_CHARS).join("")],
              { workspaceId, functionId: "memo-context-embedding" }
            )
            if (!conversationEmbedding) throw new Error("Embedding service returned no vector")
          } catch (error) {
            // Earlier attempts retry the item; the last captures against the newest twenty rather than dropping the conversation.
            if (error instanceof AISpendDeniedError || item.failedAttempts + 1 < MEMO_MAX_FAILED_ATTEMPTS) throw error
            logger.warn(
              { error, conversationId: conversation.id, workspaceId, streamId },
              "Memo context embedding failed; capturing against the newest memos only"
            )
          }
          if (conversationEmbedding) {
            const found = await MemoRepository.findNearestInStream(this.pool, {
              workspaceId,
              streamId,
              embedding: conversationEmbedding,
              scope: fetchedData.memoScope.scope,
              scopeUserId: fetchedData.memoScope.scopeUserId,
              audiences: [fetchedData.readerAudience],
              sharedRootStreamId: fetchedData.sharedRootStreamId,
              limit: MEMORY_CONTEXT_NEAREST_LIMIT,
            })
            nearest = found.map(({ memo }) => memo)
          }
        }
        const shownIds = new Set([...fetchedData.existingMemos, ...existingMemos].map((m) => m.id))
        const memoryContext = [...fetchedData.existingMemos, ...nearest.filter((memo) => !shownIds.has(memo.id))]
        // First snapshot wins: a later conversation may see a newer edit, and
        // recording that version would let this one retire text it never saw.
        for (const memo of memoryContext) if (!shownContextMemos.has(memo.id)) shownContextMemos.set(memo.id, memo)

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
          this.recordCaptureOutcome({ workspaceId, streamId, conversationId: conversation.id }, "empty", { isRevision })
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
            sharedRootStreamId: fetchedData.sharedRootStreamId,
            supersedesMemoIds: content.supersedesMemoIds,
          })
        }

        this.recordCaptureOutcome({ workspaceId, streamId, conversationId: conversation.id }, "memorized", {
          isRevision,
          memoCount: contents.length,
        })
      } catch (error) {
        // Unfingerprinted, so the retry asks the model again instead of
        // skipping the conversation as unchanged.
        const fingerprintIndex = classifiedFingerprints.findIndex((entry) => entry.id === item.id)
        if (fingerprintIndex !== -1) classifiedFingerprints.splice(fingerprintIndex, 1)
        // Blocked by a spend limit: retried once spend allows, with no cap.
        if (error instanceof AISpendDeniedError) {
          deferredItemIds.add(item.id)
          continue
        }
        failedItemIds.add(item.id)
        this.recordCaptureOutcome({ workspaceId, streamId, conversationId: item.itemId }, "failed")
        logger.error(
          { error, conversationId: item.itemId, workspaceId, streamId },
          "Failed to process conversation for memo"
        )
      }
    }

    if (failedItemIds.size > 0) {
      logger.warn(
        { workspaceId, streamId, itemsFailed: failedItemIds.size, totalItems: fetchedData.pending.length },
        "Some items failed during memo batch processing"
      )
    }

    // Save all results in one transaction so the memo rows, their outbox
    // events, and the memos:captured timeline events commit atomically.
    const saved = await withTransaction(this.pool, async (client) => {
      // Switched off while the model calls ran: save nothing. Share-locked so
      // the switch can't commit between this read and the memo writes (INV-20).
      // The stream row is locked before the save lock below, the order
      // save_memo takes them in, so the two can't deadlock.
      const memoryOn = isMemoryAutomationOn(await StreamRepository.findByIdForShare(client, workspaceId, streamId))

      // Serialize batches for this stream so a concurrent batch can't read the
      // dedup gate and insert the same memo in the window before this one
      // commits (INV-20). Transaction-scoped: released on commit/rollback.
      await MemoRepository.lockStreamSaves(client, streamId)

      // Outlived its claim and another batch took the stream over: that batch
      // owns these items now.
      if (!(await StreamStateRepository.holdsBatchClaim(client, workspaceId, streamId, claimToken))) return false

      // A source deleted while the model calls ran drops the memo; the deletion
      // requeues the conversation, so the next batch re-extracts from the rest.
      const sources = await MessageRepository.findByIds(
        client,
        workspaceId,
        memosToCreate.flatMap((m) => m.sourceMessageIds)
      )
      const sourced = memoryOn
        ? memosToCreate.filter((m) => m.sourceMessageIds.every((id) => !sources.get(id)?.deletedAt))
        : []

      // A memo edited while the model ran was judged on its old text, so
      // retiring it would discard the edit. A conversation that could retire
      // one is re-run against the edit instead. Row-locked so no edit lands
      // between this check and the supersede below (INV-20).
      const observedVersions = new Map(
        [...shownContextMemos.values(), ...[...fetchedData.existingConversationMemos.values()].flat()].map((m) => [
          m.id,
          m.cardVersion,
        ])
      )
      const retirableByConversation = new Map<string, string[]>()
      for (const memo of sourced) {
        if (!memo.sourceConversationId) continue
        const retirable = retirableByConversation.get(memo.sourceConversationId) ?? [
          ...(fetchedData.existingConversationMemos.get(memo.sourceConversationId) ?? []).map((m) => m.id),
        ]
        retirable.push(...(memo.supersedesMemoIds ?? []))
        retirableByConversation.set(memo.sourceConversationId, retirable)
      }
      const currentVersions = await MemoRepository.lockCardVersions(client, workspaceId, [
        ...new Set([...retirableByConversation.values()].flat()),
      ])
      const editedConversationIds = new Set(
        [...retirableByConversation]
          .filter(([, ids]) =>
            ids.some((id) => currentVersions.has(id) && currentVersions.get(id) !== observedVersions.get(id))
          )
          .map(([conversationId]) => conversationId)
      )
      for (const item of fetchedData.pending) {
        if (item.itemType !== "conversation" || !editedConversationIds.has(item.itemId)) continue
        deferredItemIds.add(item.id)
        const fingerprintIndex = classifiedFingerprints.findIndex((entry) => entry.id === item.id)
        if (fingerprintIndex !== -1) classifiedFingerprints.splice(fingerprintIndex, 1)
      }
      if (editedConversationIds.size > 0) {
        logger.info(
          { workspaceId, streamId, conversationIds: [...editedConversationIds] },
          "Deferred conversations whose prior memos were edited while the model ran"
        )
      }
      // Oldest knowledge first, so a retirement chain below runs in the order
      // the knowledge was said, whatever order the conversations were queued in.
      const newestSourceAt = (memo: MemoToCreate) =>
        Math.max(...memo.sourceMessageIds.map((id) => sources.get(id)?.createdAt.getTime() ?? 0))
      const savable = sourced
        .filter((m) => !m.sourceConversationId || !editedConversationIds.has(m.sourceConversationId))
        .sort((a, b) => newestSourceAt(a) - newestSourceAt(b))

      const createdMemos: MemoToCreate[] = []
      // Every memo in the batch saw the stream as it was before the batch, so
      // a later conversation reversing the same memo cites it after a
      // batch-mate already retired it. Following the retirement chain makes it
      // retire that batch-mate instead of deduping against it. Memos from one
      // conversation never chain: they are siblings, not successive versions.
      // A memo several batch-mates retired has no single successor to follow,
      // so the chain stops there.
      const retiredBy = new Map<string, MemoToCreate[]>()
      const latestOf = (id: string, conversationId: string | undefined): string => {
        let current = id
        for (;;) {
          const next = (retiredBy.get(current) ?? []).filter((m) => m.sourceConversationId !== conversationId)
          if (next.length !== 1) return current
          current = next[0].id
        }
      }
      for (const memoData of savable) {
        // Authoritative dedup (INV-20): under the lock this sees committed
        // memos from other batches AND survivors already inserted earlier in
        // this same transaction (uncommitted rows are visible to it), so it
        // subsumes the in-batch check. Same-conversation repeats are gated
        // here too — the revision prompt alone demonstrably re-emits
        // near-identical memos when a conversation is re-processed.
        const citedIds = (memoData.supersedesMemoIds ?? [])
          .filter((id) => !createdMemos.some((m) => m.id === id))
          .map((id) => latestOf(id, memoData.sourceConversationId))
        const explicitSupersedeIds = await MemoRepository.filterSupersedable(client, workspaceId, citedIds, {
          conversationId: memoData.sourceConversationId ?? null,
          sourceMessageIds: memoData.sourceMessageIds,
        })
        if (explicitSupersedeIds.length < citedIds.length) {
          logger.info(
            {
              conversationId: memoData.sourceConversationId,
              memoId: memoData.id,
              keptIds: citedIds.filter((id) => !explicitSupersedeIds.includes(id)),
            },
            "Kept cited memo(s) whose sources are newer than the capture citing them"
          )
        }

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
          audiences: [fetchedData.readerAudience],
          sharedRootStreamId: memoData.sharedRootStreamId,
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
              `Conclusion reversed; corrected knowledge already captured by ${duplicate.memo.id}`,
              duplicate.memo.id
            )
            const retired = await MemoRepository.findByIdsInWorkspace(client, workspaceId, explicitSupersedeIds)
            await publishSharedMemoChanges(client, [...retired.values()])
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
        // the stream memos it was shown, so a reversal in a later conversation
        // retires the earlier one). Embedding distance cannot catch a reversal
        // — "chose X" and "chose Y" embed far apart — so the model's citation
        // is authoritative. The embedding check below still runs for
        // unflagged paraphrase re-captures.
        if (explicitSupersedeIds.length > 0) {
          memoData.parentMemoId = explicitSupersedeIds[0]
          await MemoRepository.markSuperseded(
            client,
            workspaceId,
            explicitSupersedeIds,
            `Conclusion reversed or replaced by revised capture ${memoData.id}`,
            memoData.id
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
        // each other. Only memos locked and version-checked above may retire:
        // one restored from the archive while the model ran was never shown
        // to it, and unarchive leaves its card_version unchanged.
        const toSupersede = memoData.sourceConversationId
          ? (
              await MemoRepository.findSameConversationNear(client, {
                workspaceId,
                conversationId: memoData.sourceConversationId,
                embedding: memoData.embedding,
                maxDistance: MEMO_SUPERSEDE_DISTANCE,
                excludeIds: [...createdMemos.map((m) => m.id), ...explicitSupersedeIds],
              })
            ).filter((s) => currentVersions.has(s.memo.id))
          : []
        if (toSupersede.length > 0) {
          memoData.parentMemoId = memoData.parentMemoId ?? toSupersede[0].memo.id
          await MemoRepository.markSuperseded(
            client,
            workspaceId,
            toSupersede.map((s) => s.memo.id),
            `Superseded by revised capture ${memoData.id}`,
            memoData.id
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

        for (const id of [...explicitSupersedeIds, ...toSupersede.map((s) => s.memo.id)]) {
          retiredBy.set(id, [...(retiredBy.get(id) ?? []), memoData])
        }

        const explicitlyRetired = await MemoRepository.findByIdsInWorkspace(client, workspaceId, explicitSupersedeIds)
        Object.assign(
          memoData,
          inheritedReach([...explicitlyRetired.values(), ...toSupersede.map((s) => s.memo)], streamId)
        )

        const { embedding, ...memoFields } = memoData
        await MemoRepository.insert(client, memoFields)
        await MemoRepository.updateEmbedding(client, workspaceId, memoData.id, embedding)
        await OutboxRepository.insert(client, "memo:created", {
          workspaceId,
          streamId: fetchedData.memoScope.rootStreamId,
          memoId: memoData.id,
          ...(memoData.scopeUserId ? { scopeUserId: memoData.scopeUserId } : {}),
        })
        createdMemos.push(memoData)
      }
      memosCreated = createdMemos.length

      // Memory capture is visible in situ (INV-69): one broadcast timeline
      // event per conversation that yielded memos, in the same transaction as
      // the memo rows. Per-stream debouncing means these land just after the
      // conversations they were extracted from.
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
      const captureEvents = await recordConversationCaptures(client, workspaceId, streamId, memosByConversation)
      if (captureEvents.length > 0) {
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
      await PendingItemRepository.recordClassifiedFingerprints(client, workspaceId, classifiedFingerprints)

      const itemsToMark = fetchedData.pending.filter((p) => !deferredItemIds.has(p.id) && !failedItemIds.has(p.id))
      if (itemsToMark.length > 0) {
        await PendingItemRepository.markProcessed(client, workspaceId, itemsToMark)
      }

      const givenUp = (
        await PendingItemRepository.recordFailedAttempts(
          client,
          workspaceId,
          fetchedData.pending.filter((p) => failedItemIds.has(p.id)),
          MEMO_MAX_FAILED_ATTEMPTS
        )
      ).filter((p) => p.processedAt !== null)
      if (givenUp.length > 0) {
        logger.error(
          {
            workspaceId,
            streamId,
            conversationIds: givenUp.map((p) => p.itemId),
            maxAttempts: MEMO_MAX_FAILED_ATTEMPTS,
          },
          "Memo capture gave up on conversations after repeated failures"
        )
      }

      await StreamStateRepository.markProcessed(client, workspaceId, streamId)
      return true
    })
    if (!saved) return { processed: 0, memosCreated: 0 }

    const processed = fetchedData.pending.length - deferredItemIds.size - failedItemIds.size
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
   * provenance, and append the `memos:captured` broadcast event (INV-69 — agent
   * writes are visible in situ too). The embed runs before the transaction so no
   * connection is held across the AI call (INV-41).
   */
  async saveMemo(params: SaveMemoParams): Promise<SaveMemoResult> {
    return this.saveMemoWithAuthority(params)
  }

  async saveMemoGenerated(principal: StreamWritePrincipal, params: SaveMemoParams): Promise<SaveMemoResult> {
    return this.saveMemoWithAuthority(params, principal)
  }

  private async saveMemoWithAuthority(
    params: SaveMemoParams,
    principal?: StreamWritePrincipal
  ): Promise<SaveMemoResult> {
    const {
      workspaceId,
      streamId,
      sessionId,
      sourceStreamIds,
      provenanceStreamIds,
      audience,
      requiresBrowse,
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
      if (principal) {
        await assertStreamWritable(client, { workspaceId, streamId, principal })
      }

      // Resolves the root so a thread-backed save inherits the scratchpad tier.
      const natural = await resolveMemoScopeForStreamId(client, workspaceId, streamId)

      // Serialize against the passive batch, other saves and source deletions
      // in this root (same lock key) before the sources are read, so neither the
      // dedup gate nor a source's liveness can be read stale (INV-20).
      await MemoRepository.lockStreamSaves(client, natural.rootStreamId)

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
      let resolvedScope = natural.scope
      let resolvedScopeUserId = natural.scopeUserId
      if (scopeOverride === MemoScopes.WORKSPACE) {
        // Aside content never lands workspace-scoped: the tool's LLM-supplied
        // override downgrades to the aside's natural user tier, and the result
        // reports the scope it actually landed in.
        const root = await StreamRepository.findById(client, workspaceId, natural.rootStreamId)
        if (root?.type !== StreamTypes.ASIDE) {
          resolvedScope = MemoScopes.WORKSPACE
          resolvedScopeUserId = null
        }
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

      const duplicate = await MemoRepository.findNearDuplicate(client, {
        workspaceId,
        streamId,
        embedding,
        maxDistance: MEMO_DEDUP_DISTANCE,
        scope: resolvedScope,
        scopeUserId: resolvedScopeUserId,
        audiences: [audience ?? { kind: "room", roomStreamId: natural.rootStreamId }],
      })
      if (duplicate) {
        logger.info(
          { streamId, existingMemoId: duplicate.memo.id, distance: duplicate.distance },
          "save_memo: knowledge already captured in this stream — returning existing memo"
        )
        return { ok: true, memoId: duplicate.memo.id, title: duplicate.memo.title, deduped: true, scope: resolvedScope }
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
        sourceStreamIds: [...provenanceStreamIds, ...sourceStreamIds],
        requiresBrowse,
        scope: resolvedScope,
        scopeUserId: resolvedScopeUserId,
      })
      await MemoRepository.updateEmbedding(client, workspaceId, newMemoId, embedding)
      await OutboxRepository.insert(client, "memo:created", {
        workspaceId,
        streamId: natural.rootStreamId,
        memoId: newMemoId,
        ...(resolvedScopeUserId ? { scopeUserId: resolvedScopeUserId } : {}),
      })

      // Visible in situ (INV-69): one broadcast timeline event on the stream the
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
            workspaceId,
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
        await indexCapturedMemos(client, workspaceId, streamId, [
          { id: newMemoId, title, knowledgeType, sourceMessageIds: resolvedSourceIds },
        ])
      }

      logger.info({ streamId, memoId: newMemoId, sessionId, scope: resolvedScope }, "save_memo: agent memo created")
      return { ok: true, memoId: newMemoId, title, deduped: false, scope: resolvedScope }
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
    const {
      workspaceId,
      streamId,
      sessionId,
      digest,
      anchorMessageId,
      participantIds,
      citedStreamIds,
      citedMessageIds,
      requiresBrowse,
      authorTimezone,
    } = params
    const none = { classified: false, captured: 0, deduped: 0 }

    // Phase 1: read the stream's memo context (single connection, no AI held).
    const context = await withClient(this.pool, async (client) => {
      // A reflective memo inherits the session stream's visibility tier — research
      // residue in a private scratchpad is the owner's private tier (roadmap 6.4),
      // consistent with the passive extractor. Resolves the root first so a
      // thread-backed session still inherits the scratchpad tier. The model sees
      // only memos in that tier.
      const memoScope = await resolveMemoScopeForStreamId(client, workspaceId, streamId)
      const existingMemos = await MemoRepository.findByStream(client, workspaceId, streamId, {
        scopeUserId: memoScope.scopeUserId,
        audiences: [memorizerAudience(memoScope)],
        status: MemoStatuses.ACTIVE,
        limit: MEMORY_CONTEXT_LIMIT,
        orderBy: "sourceAt",
      })
      const existingTags = await MemoRepository.getAllTags(client, workspaceId, memoScope)
      // Only the explicit workspace setting is honored here (no participant-locale
      // fallback): a session's participants are usually just the invoking user, too
      // thin a sample to infer a canonical language from.
      const overrides = await WorkspaceSettingsRepository.findOverrides(client, workspaceId)
      const settingLanguage = overrides.find((o) => o.key === "memoLanguage")?.value
      const memoLanguage =
        typeof settingLanguage === "string" && settingLanguage.trim().length > 0 ? settingLanguage.trim() : undefined
      // Only research from the anchor's root becomes a source: a source's
      // deletion retires the memo, and the memo's readers can open it.
      const citedStreams = await StreamRepository.findByIds(client, workspaceId, citedStreamIds)
      const inRootStreamIds = citedStreams
        .filter((s) => (s.rootStreamId ?? s.id) === memoScope.rootStreamId)
        .map((s) => s.id)
      const inRootMessages = await MessageRepository.findByIdsInStreams(
        client,
        workspaceId,
        citedMessageIds,
        inRootStreamIds
      )
      const sourceMessageIds = [
        anchorMessageId,
        ...citedMessageIds.filter((id) => id !== anchorMessageId && inRootMessages.has(id)),
      ]
      return { existingMemos, existingTags, memoLanguage, memoScope, sourceMessageIds }
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

    // Phase 3: memorize. `content: []` — every reflective memo shares the sources
    // resolved in phase 1, so there is no per-memo source resolution.
    // `supersedesMemoIds` is ignored: an agent's reflection never retires a
    // memo; a human reversal lands through the conversation batch instead.
    const contents = (
      await this.memorizer.memorizeConversation(digest, {
        memoryContext: context.existingMemos,
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

    // Phase 4: save under the same per-root lock the batch/save_memo and source
    // deletions use, so neither the dedup gate nor a source's liveness can be
    // read stale (INV-20). Memo rows, their outbox events, and the
    // memos:captured timeline event commit atomically (INV-7/62).
    return withTransaction(this.pool, async (client) => {
      // Memory switched off while the model calls ran: save nothing. Same
      // share-locked gate and lock order as the passive batch.
      const root = await StreamRepository.findByIdForShare(client, workspaceId, context.memoScope.rootStreamId)
      if (!isMemoryAutomationOn(root)) {
        logger.info({ sessionId, streamId }, "reflective capture — memory switched off before save")
        return { classified: true, captured: 0, deduped: 0 }
      }

      await MemoRepository.lockStreamSaves(client, context.memoScope.rootStreamId)

      // A source deleted while the model calls ran: the memos were written from
      // it, so dropping only the citation would keep its content.
      const sources = await MessageRepository.findByIds(client, workspaceId, context.sourceMessageIds)
      if (context.sourceMessageIds.some((id) => !sources.get(id) || sources.get(id)?.deletedAt)) {
        logger.info({ sessionId, streamId }, "reflective capture — a source was deleted before save")
        return { classified: true, captured: 0, deduped: 0 }
      }

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
          audiences: [memorizerAudience(context.memoScope)],
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
          sourceMessageIds: context.sourceMessageIds,
          participantIds,
          knowledgeType: content.knowledgeType,
          tags: content.tags,
          status: MemoStatuses.ACTIVE,
          authoredByKind: AuthoredByKinds.AGENT,
          sourceSessionId: sessionId,
          sourceStreamIds: [...citedStreamIds, streamId, context.memoScope.rootStreamId],
          requiresBrowse,
          scope: context.memoScope.scope,
          scopeUserId: context.memoScope.scopeUserId,
        })
        await MemoRepository.updateEmbedding(client, workspaceId, newMemoId, embedding)
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
        // Visible in situ (INV-69): one broadcast timeline event on the session's
        // stream, carrying the anchor message's conversation so the row can be
        // placed on the board card and in the conversation panel. The event and
        // its landmark carry only the anchor: cited research can sit in threads
        // or other conversations, where clients would misplace the row.
        const anchorConversation = await ConversationRepository.findPrimaryByMessageId(
          client,
          workspaceId,
          anchorMessageId
        )
        const [captureEvent] = await StreamEventRepository.insertMany(client, [
          {
            id: eventId(),
            workspaceId,
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
        await indexCapturedMemos(
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
