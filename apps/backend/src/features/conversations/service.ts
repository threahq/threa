import { Pool } from "pg"
import { withClient, withTransaction, type Querier } from "../../db"
import { ConversationRepository, type Conversation } from "./repository"
import { ConversationFeedbackRepository } from "./feedback-repository"
import { MessageRepository, type Message } from "../messaging"
import { StreamRepository, applySparseRead, applySparseUnread, type ReadStateSnapshot } from "../streams"
import { ActivityRepository } from "../activity"
import { AttachmentRepository, hydrateAttachmentSummaries } from "../attachments"
import { LinkPreviewRepository, toLinkPreviewSummary } from "../link-previews"
import { MemoRepository } from "../memos"
import { OutboxRepository } from "../../lib/outbox"
import { addStalenessFields, type ConversationWithStaleness } from "./staleness"
import { resolveConversationDelivery } from "./conversation-delivery"
import { effectiveRootId } from "./conversation-assigner"
import { conversationFeedbackId, conversationId as generateConversationId } from "../../lib/id"
import { HttpError } from "../../lib/errors"
import { logger } from "../../lib/logger"
import {
  ConversationStatuses,
  StreamTypes,
  type AttachmentSummary,
  type BoardLens,
  type BoardScopeStreamType,
  type ConversationStatus,
  type LinkPreviewSummary,
} from "@threa/types"

export { ConversationWithStaleness }

export interface ListConversationsOptions {
  status?: ConversationStatus
  limit?: number
}

export interface ListWorkspaceConversationsOptions extends ListConversationsOptions {
  /** Structural lens (`all` = no narrowing — the default home shows everything). */
  lens?: BoardLens
  /** Root-stream scope: only conversations under these streams. */
  scopeStreamIds?: string[]
  /** Root-stream TYPE scope: only conversations whose root is one of these types. */
  scopeStreamTypes?: string[]
  /** Stream veto: drop conversations whose anchor or effective root is named. */
  excludeStreamIds?: string[]
  /** Root-stream TYPE veto: drop conversations whose root is one of these types. */
  excludeStreamTypes?: string[]
  /** Label scope: only conversations whose anchor/root carries one of the viewer's labels. */
  scopeLabelIds?: string[]
  /** Label veto: drop conversations whose anchor/root carries one of the viewer's labels. */
  excludeLabelIds?: string[]
  /** Include conversations under archived streams; defaults to hiding them. */
  showArchived?: boolean
  /** Keyset cursor from a prior page's `nextCursor` (the last row's activity + id). */
  cursor?: { lastActivityAt: string; id: string }
}

/**
 * Opening message of a board post (internal, Date-typed; serialized to the wire
 * `BoardPostMessage` by the handler). A lean projection of the full message —
 * the fields the post card renders.
 */
export interface BoardPostMessage {
  id: string
  /** The stream this message lives in. A conversation can span its root + the
   * root's threads (one root, board-view-design.md), so each message carries its
   * own origin — the client merges the rails of the streams its members span. */
  streamId: string
  authorId: string
  authorType: Message["authorType"]
  contentMarkdown: string
  reactions: Record<string, string[]>
  attachments: AttachmentSummary[]
  linkPreviews: LinkPreviewSummary[]
  createdAt: Date
  editedAt: Date | null
}

/** A conversation surfaced as a feed post: the grouping, its origin message, and the latest replies. */
export interface BoardPost {
  conversation: ConversationWithStaleness
  /** The post's origin: the conversation's first message, or — for a thread —
   * the parent message in the parent stream that the thread descends from. */
  openingMessage: BoardPostMessage | null
  /** The trailing reply messages (up to 3), chronological. */
  recentMessages: BoardPostMessage[]
  /** Total replies under the origin (excludes the origin). Drives the "N more" gap. */
  totalReplies: number
  /** Distinct streams this post's rendered messages span (opening + recent) — the
   * root and any threads the conversation reaches under it. The client subscribes
   * to each one's rail so a cross-stream member draws live (board-view-design.md). */
  streamIds: string[]
  /** Whether an active memo was captured from this conversation — the Decisions lens signal. */
  hasCapturedMemo: boolean
  /** Whether the requesting viewer authored/participates in or was @-mentioned in this conversation — the Mine lens signal. */
  isMine: boolean
  /** Effective root of the anchor (`COALESCE(root_stream_id, id)`) — the client's stream-scope filter matches on this. */
  rootStreamId: string
  /** That root's type (never `thread`) — the client's stream-type filter matches on this. */
  rootStreamType: BoardScopeStreamType | undefined
  /** Whether that effective root is archived — the client drops archived cards
   *  seeded under `?archived=true` once the viewer toggles archived back off. */
  rootArchived: boolean
}

export interface ReassignMessageParams {
  workspaceId: string
  /** Target conversation that should become the message's primary home. */
  conversationId: string
  messageId: string
  /** The correcting user — recorded with the feedback row. */
  userId: string
}

export interface ReassignMessageResult {
  conversation: ConversationWithStaleness
  /** The conversation the message left, or null if it had no primary before. */
  previousConversation: ConversationWithStaleness | null
}

export interface SplitThreadParams {
  workspaceId: string
  /** The source conversation the thread is being split out of. */
  conversationId: string
  /** The thread stream to promote into its own conversation. */
  threadStreamId: string
  /** The correcting user — recorded with each moved message's feedback row. */
  actorUserId: string
}

export interface SplitThreadResult {
  /** The freshly minted conversation now anchoring the thread. */
  conversation: ConversationWithStaleness
  /** The source conversation the thread was split out of. */
  sourceConversation: ConversationWithStaleness
}

/** Where a batch reassignment lands: an existing conversation in the stream, or
 *  a freshly minted one (the "split into its own topic" gesture). */
export type ReassignMessagesTarget = { kind: "existing"; conversationId: string } | { kind: "new" }

export interface ReassignMessagesParams {
  workspaceId: string
  /** The stream the selected messages live in — the anchor for a minted
   *  conversation, and the stream every selected message must belong to. */
  streamId: string
  /** The messages to reassign (1..N). Deduped; order is re-derived from `sequence`. */
  messageIds: string[]
  /** Destination: an existing conversation in the stream, or a fresh mint. */
  target: ReassignMessagesTarget
  /** The correcting user — recorded with each moved message's feedback row. */
  actorUserId: string
}

export interface ReassignMessagesResult {
  /** The destination conversation (minted or existing) with final membership. */
  conversation: ConversationWithStaleness
  /** Every source conversation that lost members, with final membership. */
  sourceConversations: ConversationWithStaleness[]
}

/** One confirmed topic group from an AI split proposal (see {@link ConversationService.applySplit}). */
export interface ApplySplitGroup {
  /** Model-proposed (user-confirmable) title for the group. */
  title: string
  summary?: string
  /** Messages assigned to this group — a subset of the source conversation. */
  messageIds: string[]
}

export interface ApplySplitParams {
  workspaceId: string
  /** The stream the source conversation and every message live in. */
  streamId: string
  /** The conversation being split. */
  conversationId: string
  /** ≥2 groups partitioning the split messages; `groups[0]` is kept in the source
   *  conversation (re-titled), the rest are minted as new conversations. */
  groups: ApplySplitGroup[]
  /** The splitting user — recorded with each moved message's feedback row. */
  actorUserId: string
}

export interface ApplySplitResult {
  /** The source conversation, re-titled to the kept group, with final membership. */
  conversation: ConversationWithStaleness
  /** The freshly minted conversations, one per moved group, in group order. */
  newConversations: ConversationWithStaleness[]
}

/**
 * Public interface for querying conversations.
 * Computes temporal staleness on read.
 */
export class ConversationService {
  constructor(private pool: Pool) {}

  async getById(conversationId: string): Promise<ConversationWithStaleness | null> {
    // Single query, INV-30
    const conversation = await ConversationRepository.findById(this.pool, conversationId)
    if (!conversation) return null
    return addStalenessFields(conversation)
  }

  async listByStream(streamId: string, options?: ListConversationsOptions): Promise<ConversationWithStaleness[]> {
    // Single query, INV-30
    const conversations = await ConversationRepository.findByStreamIncludingThreads(this.pool, streamId, options)
    return conversations.map(addStalenessFields)
  }

  /**
   * Cross-stream feed for the workspace board: conversations the viewer can read,
   * newest activity first, keyset-paginated. Access filtering happens in SQL
   * (INV-62), so `userId` is required here unlike the stream-scoped
   * {@link listByStream}. Returns `nextCursor` (opaque `"<iso>|<id>"`) when a full
   * page came back, so the board pages on instead of silently truncating.
   */
  async listByWorkspace(
    workspaceId: string,
    userId: string,
    options?: ListWorkspaceConversationsOptions
  ): Promise<{ posts: BoardPost[]; nextCursor: string | null }> {
    const limit = options?.limit ?? 50
    const rows = await ConversationRepository.findByWorkspaceForViewer(this.pool, workspaceId, userId, {
      ...options,
      limit,
    })
    const conversations = rows.map(addStalenessFields)

    const posts = await this.buildBoardPosts(workspaceId, conversations, userId)

    // A full page means there may be more; the last row's (activity, id) is the
    // next cursor — matching the repo's `(last_activity_at, id) DESC` order.
    const last = conversations.length === limit ? conversations[conversations.length - 1] : null
    const nextCursor = last ? `${last.lastActivityAt.toISOString()}|${last.id}` : null
    return { posts, nextCursor }
  }

  /**
   * The board post for a single conversation — the same projection
   * {@link listByWorkspace} builds per row, for the conversation panel
   * (Mechanism B, board-view-design.md). Access is the caller's responsibility
   * (the handler runs the single-root check, INV-62), matching
   * {@link getBoardMessages}. Returns `null` when the conversation is in another
   * workspace or has no messages (an emptied conversation is no longer a card,
   * mirroring the board feed's `cardinality(message_ids) > 0` filter).
   */
  async getBoardPostById(workspaceId: string, conversationId: string, userId: string): Promise<BoardPost | null> {
    const conversation = await ConversationRepository.findById(this.pool, conversationId)
    if (!conversation || conversation.workspaceId !== workspaceId || conversation.messageIds.length === 0) return null
    const [post] = await this.buildBoardPosts(workspaceId, [addStalenessFields(conversation)], userId)
    return post ?? null
  }

  /**
   * Project access-filtered conversations into board posts: resolve each one's
   * origin (a thread's opener lives in the parent stream, not the thread), pick
   * the recent reply window by `createdAt` (not `message_ids` insertion order — a
   * cross-stream attach interleaves the array out of time, board-view-design.md),
   * and hydrate the opening + window with attachments/link previews. Callers must
   * have already enforced access (SQL filter for the feed, single-root check for
   * the single fetch); this does no access work of its own.
   */
  private async buildBoardPosts(
    workspaceId: string,
    conversations: ConversationWithStaleness[],
    userId: string
  ): Promise<BoardPost[]> {
    if (conversations.length === 0) return []

    // Resolve each conversation's stream so a thread post can show its true
    // origin: a thread is its own stream, so its `messageIds` are the replies and
    // the originating message lives in the parent stream (`parentMessageId`),
    // never a member of the thread conversation.
    const streamIds = [...new Set(conversations.map((c) => c.streamId))]
    const streamById = new Map(
      (streamIds.length > 0 ? await StreamRepository.findByIds(this.pool, streamIds) : []).map((s) => [s.id, s])
    )
    // A thread anchor's ROOT row (for `rootStreamType`) isn't among the anchors —
    // fetch the missing roots in one extra batch (INV-56).
    const missingRootIds = [
      ...new Set(
        [...streamById.values()]
          .map((s) => s.rootStreamId)
          .filter((id): id is string => Boolean(id) && !streamById.has(id!))
      ),
    ]
    for (const root of missingRootIds.length > 0 ? await StreamRepository.findByIds(this.pool, missingRootIds) : []) {
      streamById.set(root.id, root)
    }

    // Fetch every member message row (opening + all replies) in one batch
    // (INV-56) so the recent window is chosen by `createdAt`, not by `message_ids`
    // insertion order — a cross-stream attach interleaves the array out of time
    // (board-view-design.md). The access filter already ran in the conversation
    // query, so these ids are viewer-readable. Rich hydration (attachments / link
    // previews) below is then limited to the opening + the chosen window.
    const memberIdsToFetch = new Set<string>()
    for (const conversation of conversations) {
      const stream = streamById.get(conversation.streamId)
      const anchorMessageId = stream?.parentAnchorId?.startsWith("msg_") ? stream.parentAnchorId : null
      if (stream?.type === StreamTypes.THREAD && anchorMessageId) memberIdsToFetch.add(anchorMessageId)
      for (const id of conversation.messageIds) memberIdsToFetch.add(id)
    }
    const memberIds = [...memberIdsToFetch]
    const messageById: Map<string, Message> =
      memberIds.length > 0 ? await MessageRepository.findByIds(this.pool, memberIds) : new Map()

    const planByConversation = new Map<
      string,
      { originId: string | undefined; recentIds: string[]; totalReplies: number }
    >()
    const hydrateIds = new Set<string>()
    for (const conversation of conversations) {
      const stream = streamById.get(conversation.streamId)
      const anchorMessageId = stream?.parentAnchorId?.startsWith("msg_") ? stream.parentAnchorId : null
      let originId: string | undefined
      let replyIds: string[]
      if (stream?.type === StreamTypes.THREAD && anchorMessageId) {
        originId = anchorMessageId
        replyIds = conversation.messageIds
      } else {
        originId = conversation.messageIds[0]
        replyIds = conversation.messageIds.slice(1)
      }
      // Chronological by `createdAt`; an id with no fetched row (deleted /
      // unreadable) sinks to the end so it can't claim a recent slot.
      const orderedReplyIds = [...replyIds].sort(
        (a, b) =>
          (messageById.get(a)?.createdAt.getTime() ?? Infinity) - (messageById.get(b)?.createdAt.getTime() ?? Infinity)
      )
      const recentIds = orderedReplyIds.slice(Math.max(0, orderedReplyIds.length - 3))
      planByConversation.set(conversation.id, { originId, recentIds, totalReplies: replyIds.length })
      if (originId) hydrateIds.add(originId)
      for (const id of recentIds) hydrateIds.add(id)
    }
    const hydratedById = await this.hydrateBoardMessages(
      workspaceId,
      [...hydrateIds].map((id) => messageById.get(id)).filter((m): m is Message => Boolean(m))
    )

    // The Decisions/Knowledge lens signal: which of these conversations produced a
    // captured memo. One batch presence read (INV-56); a board-level field, not on
    // the conversation aggregate the `conversation:*` events carry.
    const conversationIdsWithMemos = await MemoRepository.findConversationIdsWithMemos(
      this.pool,
      workspaceId,
      conversations.map((c) => c.id)
    )

    // The Mine lens signal: which of these conversations' primary messages
    // `@`-mentioned the viewer. Participation (`participant_ids`) is checked
    // in-memory below (zero query); only the mention set costs one batched read
    // (INV-56). Pinned to primary `message_ids` — the SAME set the SQL half
    // (`boardLensCondSql` mine branch) tests — so the seed boundary and the
    // rendered `isMine` can't disagree.
    const mentionedMessageIds = await ActivityRepository.findMentionedMessageIds(this.pool, workspaceId, userId, [
      ...new Set(conversations.flatMap((c) => c.messageIds)),
    ])

    const posts: BoardPost[] = conversations.map((conversation) => {
      const plan = planByConversation.get(conversation.id)!
      const opening = plan.originId ? hydratedById.get(plan.originId) : undefined
      const recentMessages = plan.recentIds
        .map((id) => hydratedById.get(id))
        .filter((m): m is BoardPostMessage => Boolean(m))
      // The streams this card's rendered messages span — the conversation's
      // anchor plus any thread an opening/recent message lives in. The client
      // merges these rails so a cross-stream member draws live; new threads added
      // after this snapshot arrive via `conversation:message_assigned`.
      const streamIds = [
        ...new Set([
          conversation.streamId,
          ...(opening ? [opening.streamId] : []),
          ...recentMessages.map((m) => m.streamId),
        ]),
      ]
      const rootStreamId = streamById.get(conversation.streamId)?.rootStreamId ?? conversation.streamId
      return {
        conversation,
        openingMessage: opening ?? null,
        recentMessages,
        totalReplies: plan.totalReplies,
        streamIds,
        hasCapturedMemo: conversationIdsWithMemos.has(conversation.id),
        isMine:
          conversation.participantIds.includes(userId) ||
          conversation.messageIds.some((id) => mentionedMessageIds.has(id)),
        // Effective root of the anchor (and its type) — the client's stream-scope
        // and stream-type filters match on these, mirroring the SQL
        // `COALESCE(root_stream_id, id)` rule.
        rootStreamId,
        // The root row's type is one of the scope grains by construction (a root
        // is never a thread); the cast narrows the broader StreamType.
        rootStreamType: streamById.get(rootStreamId)?.type as BoardScopeStreamType | undefined,
        // Archived state of the effective root — matches `boardArchivedExcludeSql`
        // (archiving marks only the root row, INV-62). Only ever true for a card
        // seeded under `?archived=true`; the client uses it to re-hide the card
        // when archived is toggled back off. Missing root row (deleted) → false.
        rootArchived: streamById.get(rootStreamId)?.archivedAt != null,
      }
    })

    return posts
  }

  /**
   * Enrich a set of messages with their attachments + completed link previews —
   * the rich content the message row doesn't carry. One batch read each (INV-56).
   * Shared by the board feed and the board's on-expand message fetch so both
   * render the same richness as the timeline.
   */
  private async hydrateBoardMessages(workspaceId: string, messages: Message[]): Promise<Map<string, BoardPostMessage>> {
    const byId = new Map<string, BoardPostMessage>()
    const ids = messages.map((m) => m.id)
    if (ids.length === 0) return byId
    const attachmentsByMessage = await AttachmentRepository.findByMessageIds(this.pool, ids)
    const linkPreviewsByMessage = await LinkPreviewRepository.findByMessageIds(this.pool, workspaceId, ids)
    const summariesByMessage = await hydrateAttachmentSummaries(this.pool, workspaceId, attachmentsByMessage)
    for (const message of messages) {
      const attachments = summariesByMessage.get(message.id) ?? []
      const linkPreviews = (linkPreviewsByMessage.get(message.id) ?? [])
        .filter((p) => p.status === "completed")
        .map((p, i) => toLinkPreviewSummary(p, i))
      byId.set(message.id, toBoardPostMessage(message, attachments, linkPreviews))
    }
    return byId
  }

  /**
   * The full conversation as board post messages (enriched with attachments +
   * link previews), in message order — backs the board card's "N more" expand so
   * the revealed middle messages read exactly like the opening + recent run.
   */
  async getBoardMessages(workspaceId: string, conversationId: string): Promise<BoardPostMessage[]> {
    const conversation = await ConversationRepository.findById(this.pool, conversationId)
    if (!conversation || conversation.workspaceId !== workspaceId || conversation.messageIds.length === 0) return []
    const messagesMap = await MessageRepository.findByIds(this.pool, conversation.messageIds)
    const ordered = conversation.messageIds.map((id) => messagesMap.get(id)).filter((m): m is Message => Boolean(m))
    const hydratedById = await this.hydrateBoardMessages(workspaceId, ordered)
    // Flattened-chronological across the root + its threads (the conversation can
    // span streams under one root, board-view-design.md): `message_ids` is
    // insertion order, which a cross-stream attach interleaves out of time, so
    // sort by `createdAt` rather than trusting array position.
    return [...hydratedById.values()].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  }

  async listByMessage(workspaceId: string, messageId: string): Promise<ConversationWithStaleness[]> {
    // Single query, INV-30
    const conversations = await ConversationRepository.findByMessageId(this.pool, workspaceId, messageId)
    return conversations.map(addStalenessFields)
  }

  async getMessages(conversationId: string): Promise<Message[]> {
    return withClient(this.pool, async (client) => {
      const conversation = await ConversationRepository.findById(client, conversationId)
      if (!conversation || conversation.messageIds.length === 0) return []

      const messagesMap = await MessageRepository.findByIds(client, conversation.messageIds)

      return conversation.messageIds.map((id) => messagesMap.get(id)).filter((m): m is Message => m !== undefined)
    })
  }

  /**
   * User correction: move a message's primary membership to another
   * conversation under the same effective root — same stream, or between the
   * root and one of its threads (the board's "move to sub-topic" re-file).
   * Membership only; the message row never changes streams. Applies the move
   * immediately (same repository operations the boundary extractor uses) and
   * records a `conversation_feedback` row as ground truth for improving
   * extraction.
   *
   * Mirrors the boundary extractor's persist phase: message row locked
   * FOR UPDATE before reading the current primary (INV-20), membership
   * arrays + feedback + outbox events all committed in one transaction
   * (INV-7), events delivered via the outbox (INV-4).
   */
  async reassignMessage(params: ReassignMessageParams): Promise<ReassignMessageResult> {
    const { workspaceId, conversationId, messageId, userId } = params

    return withTransaction(this.pool, async (client) => {
      const target = await ConversationRepository.findById(client, conversationId)
      if (!target || target.workspaceId !== workspaceId) {
        throw new HttpError("Conversation not found", { status: 404, code: "CONVERSATION_NOT_FOUND" })
      }

      // Lock-then-read in one statement (INV-20): the same row lock that
      // serializes us against concurrent boundary extractions also guarantees
      // the streamId/authorId we validate against can't be changed by a
      // concurrent message move between read and write.
      const message = await MessageRepository.findByIdForUpdate(client, messageId)
      if (!message) {
        throw new HttpError("Message not found", { status: 404, code: "MESSAGE_NOT_FOUND" })
      }
      // One-root rule, same as the assigner's `existing` directive: same stream
      // passes trivially; a cross-stream move between the root and its threads
      // (the board's "move to sub-topic" re-file) passes; a cross-root move is
      // rejected. Membership moves only — the message row itself never leaves
      // its stream (re-file, not relocation).
      if (message.streamId !== target.streamId) {
        const [targetRoot, messageRoot] = await Promise.all([
          effectiveRootId(client, target.streamId),
          effectiveRootId(client, message.streamId),
        ])
        if (targetRoot !== messageRoot) {
          throw new HttpError("Conversation is in a different root stream", {
            status: 400,
            code: "CONVERSATION_NOT_IN_ROOT",
          })
        }
      }

      const previous = await ConversationRepository.findPrimaryByMessageId(client, workspaceId, messageId)
      if (previous?.id === target.id) {
        // Already where the user wants it — report current state, record nothing.
        return { conversation: addStalenessFields(target), previousConversation: null }
      }

      if (previous) {
        await ConversationRepository.removePrimaryMessage(client, workspaceId, previous.id, messageId)
        // Moving a conversation's only message out leaves an empty shell that
        // would otherwise stay "active" forever; resolve it. Moving a message
        // back into it (the undo path) reactivates it below.
        await ConversationRepository.resolveIfEmpty(client, workspaceId, previous.id)
      }
      await ConversationRepository.addPrimaryMessage(client, workspaceId, target.id, messageId, message.authorId)
      // Deliberately unconditional, not just for the undo path: a user moving
      // a message into ANY resolved conversation is declaring it has activity
      // again, so it returns to the active lifecycle.
      await ConversationRepository.reactivateIfInactive(client, workspaceId, target.id)

      await ConversationFeedbackRepository.insert(client, {
        id: conversationFeedbackId(),
        workspaceId,
        streamId: message.streamId,
        messageId,
        fromConversationId: previous?.id ?? null,
        toConversationId: target.id,
        userId,
      })

      const touchedIds = previous ? [previous.id, target.id] : [target.id]
      await ConversationRepository.bumpActivityForIds(client, workspaceId, touchedIds)

      // `previous` and `target` share one access root (the one-root guard above,
      // INV-62) but can be anchored in different streams under it — the root and
      // one of its threads — so delivery is resolved per conversation stream,
      // mirroring the boundary extractor's cross-stream persist.
      const deliveryByStreamId = new Map<string, Awaited<ReturnType<typeof resolveConversationDelivery>>>()
      const deliveryFor = async (streamId: string) => {
        let resolved = deliveryByStreamId.get(streamId)
        if (!resolved) {
          const stream = await StreamRepository.findById(client, streamId)
          resolved = await resolveConversationDelivery(client, stream)
          deliveryByStreamId.set(streamId, resolved)
        }
        return resolved
      }

      const touched = await ConversationRepository.findByIds(client, workspaceId, touchedIds)
      for (const conv of touched) {
        const { parentStreamId, streamVisibility } = await deliveryFor(conv.streamId)
        await OutboxRepository.insert(client, "conversation:updated", {
          workspaceId,
          streamId: conv.streamId,
          conversationId: conv.id,
          conversation: addStalenessFields(conv),
          parentStreamId,
          streamVisibility,
        })
      }

      if (previous) {
        await OutboxRepository.insert(client, "conversation:message_reassigned", {
          workspaceId,
          streamId: message.streamId,
          messageId,
          fromConversationId: previous.id,
          toConversationId: target.id,
          reason: "user_correction",
        })
      } else {
        await OutboxRepository.insert(client, "conversation:message_assigned", {
          workspaceId,
          streamId: message.streamId,
          parentStreamId: (await deliveryFor(message.streamId)).parentStreamId,
          messageId,
          conversationId: target.id,
          isPrimary: true,
          reason: "user_correction",
        })
      }

      const findTouched = (id: string): Conversation | undefined => touched.find((c) => c.id === id)
      const updatedTarget = findTouched(target.id)
      if (!updatedTarget) {
        // The target row vanished mid-transaction despite the row lock — fail
        // loudly (INV-11) rather than returning stale membership.
        throw new Error(`Conversation ${target.id} disappeared during reassignment`)
      }
      const updatedPrevious = previous ? findTouched(previous.id) : undefined

      return {
        conversation: addStalenessFields(updatedTarget),
        previousConversation: updatedPrevious ? addStalenessFields(updatedPrevious) : null,
      }
    })
  }

  /**
   * User edit of a conversation's own fields from the board card / panel: rename
   * the topic (`topicSummary`) and/or mark it resolved/reopened (`status`). The
   * atomic `UPDATE … RETURNING` is race-safe on its own (INV-20) — no lock, no
   * check-then-act — and `topic_summary` is written only at insert by the
   * extractor (never on an existing conversation), so a user title is never
   * clobbered by a later extraction pass. Emits `conversation:updated` in the same
   * transaction (INV-7); the update touches `updated_at`, not `last_activity_at`,
   * so the card changes in place without re-sorting the board (stable view).
   */
  async updateConversation(params: {
    workspaceId: string
    conversationId: string
    topicSummary?: string
    status?: ConversationStatus
  }): Promise<{ conversation: ConversationWithStaleness }> {
    const { workspaceId, conversationId, topicSummary, status } = params
    return withTransaction(this.pool, async (client) => {
      const updated = await ConversationRepository.update(client, workspaceId, conversationId, {
        topicSummary,
        status,
        // A user-set status is authoritative — lock it so the extractor's LLM stops
        // overriding it (user resolution wins over the AI's ruling). Only when the
        // user actually set status; a rename alone leaves the lock untouched.
        statusLockedByUser: status !== undefined ? true : undefined,
      })
      if (!updated) {
        throw new HttpError("Conversation not found", { status: 404, code: "CONVERSATION_NOT_FOUND" })
      }
      const stream = await StreamRepository.findById(client, updated.streamId)
      const { parentStreamId, streamVisibility } = await resolveConversationDelivery(client, stream)
      await OutboxRepository.insert(client, "conversation:updated", {
        workspaceId,
        streamId: updated.streamId,
        conversationId: updated.id,
        conversation: addStalenessFields(updated),
        parentStreamId,
        streamVisibility,
      })
      return { conversation: addStalenessFields(updated) }
    })
  }

  /**
   * User correction from the board: split a soft thread out of its parent
   * conversation into its own topic. Reassigns the thread's member messages —
   * and any deeper sub-topic thread's — to a freshly minted conversation
   * anchored to the thread. The source keeps its opener and stays active; the
   * board card re-forms the split-off thread as a nested branch group.
   *
   * Mirrors {@link reassignMessage}'s discipline: the source row is locked
   * before its membership is read (INV-20), the moving message rows are locked
   * in a deterministic order, and the membership move + feedback + outbox events
   * all commit in one transaction (INV-6/7), delivered via the outbox (INV-4).
   * The minted conversation follows the fresh-mint title precedent (no
   * topicSummary — the extractor fills it), never copying the parent's title.
   */
  async splitThreadIntoConversation(params: SplitThreadParams): Promise<SplitThreadResult> {
    const { workspaceId, conversationId, threadStreamId, actorUserId } = params

    return withTransaction(this.pool, async (client) => {
      // Lock the source: any op that removes a primary from it must UPDATE this
      // row, so holding the lock keeps `messageIds` stable through the split and
      // serializes a concurrent split (the loser re-reads an empty move set).
      const source = await ConversationRepository.findByIdForUpdate(client, workspaceId, conversationId)
      if (!source) {
        throw new HttpError("Conversation not found", { status: 404, code: "CONVERSATION_NOT_FOUND" })
      }

      const threadStream = await StreamRepository.findById(client, threadStreamId)
      if (!threadStream || threadStream.type !== StreamTypes.THREAD) {
        throw new HttpError("Split target is not a thread", { status: 400, code: "NOT_A_THREAD" })
      }

      // One-root invariant (INV-62): the thread being promoted must share the
      // source anchor's effective root — a thread is same-root by construction,
      // so this only rejects a foreign/crafted `threadStreamId`.
      const sourceStream = await StreamRepository.findById(client, source.streamId)
      const threadRoot = threadStream.rootStreamId ?? threadStream.id
      const sourceRoot = sourceStream?.rootStreamId ?? source.streamId
      if (threadRoot !== sourceRoot) {
        throw new HttpError("Thread is in a different root stream", {
          status: 400,
          code: "CONVERSATION_NOT_IN_ROOT",
        })
      }

      // The thread's fork message must be a member of the source — it's the
      // branch point the split heals into its own topic.
      const forkMessageId = threadStream.parentAnchorId?.startsWith("msg_") ? threadStream.parentAnchorId : null
      if (!forkMessageId || !source.messageIds.includes(forkMessageId)) {
        throw new HttpError("Thread's fork message is not in the conversation", {
          status: 400,
          code: "FORK_MESSAGE_NOT_MEMBER",
        })
      }

      // Move set: source members whose stream is the thread or one of its
      // descendant threads (deeper sub-topics move with it). One recursive query
      // for the subtree (INV-56), then filter members by their own stream.
      const subtreeIds = new Set(await StreamRepository.listSelfAndDescendantIds(client, threadStreamId))
      const memberMessages = await MessageRepository.findByIds(client, source.messageIds)
      const moveIds = source.messageIds.filter((id) => {
        const streamId = memberMessages.get(id)?.streamId
        return streamId != null && subtreeIds.has(streamId)
      })
      if (moveIds.length === 0) {
        throw new HttpError("Thread has no messages in this conversation", {
          status: 400,
          code: "NO_THREAD_MEMBERS",
        })
      }

      // Lock the moving rows (INV-20) in a deterministic order — the batch
      // counterpart to reassign's single-row `FOR UPDATE`.
      await MessageRepository.findByIdsForUpdate(client, moveIds)

      const movedSet = new Set(moveIds)
      const remainingIds = source.messageIds.filter((id) => !movedSet.has(id))
      const movedAuthors = distinctAuthors(moveIds, memberMessages)
      const remainingAuthors = distinctAuthors(remainingIds, memberMessages)

      const newId = generateConversationId()
      await ConversationRepository.insert(client, {
        id: newId,
        streamId: threadStreamId,
        workspaceId,
        confidence: 1,
        status: ConversationStatuses.ACTIVE,
      })

      await ConversationRepository.removePrimaryMessages(client, workspaceId, source.id, moveIds, remainingAuthors)
      await ConversationRepository.addPrimaryMessages(client, workspaceId, newId, moveIds, movedAuthors)
      await ConversationRepository.bumpActivityForIds(client, workspaceId, [source.id, newId])

      // Feedback ground truth — one row per moved message (parity with
      // {@link reassignMessage}), batched (INV-56).
      await ConversationFeedbackRepository.insertMany(
        client,
        moveIds.map((messageId) => ({
          id: conversationFeedbackId(),
          workspaceId,
          streamId: memberMessages.get(messageId)!.streamId,
          messageId,
          fromConversationId: source.id,
          toConversationId: newId,
          userId: actorUserId,
        }))
      )

      // Re-read both rows post-write so the aggregate events carry final membership.
      const newConversation = await ConversationRepository.findById(client, newId)
      const updatedSource = await ConversationRepository.findById(client, source.id)
      if (!newConversation || !updatedSource) {
        // A row we just wrote vanished under our own transaction — fail loud (INV-11).
        throw new Error(`Conversation vanished during split of ${source.id}`)
      }

      // Each aggregate event routes by its OWN access root (INV-62): the new
      // conversation lives in the thread (parent-channel discoverability), the
      // source in its anchor.
      const threadDelivery = await resolveConversationDelivery(client, threadStream)
      await OutboxRepository.insert(client, "conversation:created", {
        workspaceId,
        streamId: newConversation.streamId,
        conversationId: newConversation.id,
        conversation: addStalenessFields(newConversation),
        parentStreamId: threadDelivery.parentStreamId,
        streamVisibility: threadDelivery.streamVisibility,
      })

      const sourceDelivery = await resolveConversationDelivery(client, sourceStream)
      await OutboxRepository.insert(client, "conversation:updated", {
        workspaceId,
        streamId: updatedSource.streamId,
        conversationId: updatedSource.id,
        conversation: addStalenessFields(updatedSource),
        parentStreamId: sourceDelivery.parentStreamId,
        streamVisibility: sourceDelivery.streamVisibility,
      })

      // Per-message move events route to each message's own stream (the thread),
      // for the timeline membership map + extraction feedback.
      for (const messageId of moveIds) {
        await OutboxRepository.insert(client, "conversation:message_reassigned", {
          workspaceId,
          streamId: memberMessages.get(messageId)!.streamId,
          messageId,
          fromConversationId: source.id,
          toConversationId: newId,
          reason: "user_correction",
        })
      }

      return {
        conversation: addStalenessFields(newConversation),
        sourceConversation: addStalenessFields(updatedSource),
      }
    })
  }

  /**
   * User correction from the timeline conversation overlay: reassign a hand-picked
   * SET of messages to another conversation — an existing one, or a freshly minted
   * one (the "these should be their own topic" split). The batch counterpart to
   * {@link reassignMessage}; membership-only, like {@link splitThreadIntoConversation}
   * — no message events move, so broadcast sequences and INV-61 contiguity are
   * untouched (the messages stay in their stream).
   *
   * Concurrency (INV-20): conversation rows are locked BEFORE the message rows,
   * and EVERY one of them — an existing destination and all sources — in a single
   * globally sorted order, so no two callers can take the same pair of rows in
   * opposite orders (the AB-BA cycle a "destination first, then sources" order
   * would allow when two calls target each other's conversations). The lock set is
   * chosen from an unlocked peek at current membership; the grouping is re-read
   * authoritatively once the messages are pinned, and no further conversation lock
   * is ever taken after that (a conv lock after a message lock is the one ordering
   * that could still cycle) — a message whose primary raced into an un-pre-locked
   * conversation is simply left where it is. Holding each source lock lets its
   * `participant_ids` be recomputed without a concurrent extraction clobbering the
   * array. (This total order is deadlock-free against itself and against
   * {@link splitThreadIntoConversation}, also conversation-first. The singular
   * {@link reassignMessage} takes locks the other way — message row first, then the
   * conversation rows via its UPDATEs — the same pre-existing cross-order those two
   * already have; a rare cross-path cycle there is transient, since `withTransaction`
   * retries 40P01 with backoff.) All member/feedback writes and the outbox events
   * commit in one transaction (INV-6/7), delivered via the outbox (INV-4). A minted
   * destination follows the fresh-mint precedent (no `topicSummary` — the extractor
   * fills it), never copying a source title.
   */
  async reassignMessagesToConversation(params: ReassignMessagesParams): Promise<ReassignMessagesResult> {
    const { workspaceId, streamId, messageIds, target, actorUserId } = params

    return withTransaction(this.pool, async (client) => {
      const uniqueIds = [...new Set(messageIds)]

      // Unlocked peek: chooses the conversation lock set only. The authoritative
      // grouping is re-read below once the messages are pinned.
      const preReadPrimaries = await ConversationRepository.findPrimariesByMessageIds(client, workspaceId, uniqueIds)

      // Lock the destination + every source in ONE globally sorted order (see the
      // method doc) — the destination is not special-cased first, so two calls
      // targeting each other's conversations can't deadlock.
      const existingDestinationId = target.kind === "existing" ? target.conversationId : null
      const lockOrder = [
        ...new Set([
          ...(existingDestinationId ? [existingDestinationId] : []),
          ...[...preReadPrimaries.values()].map((c) => c.id),
        ]),
      ].sort()
      const lockedConversations = new Map<string, Conversation>()
      for (const id of lockOrder) {
        const row = await ConversationRepository.findByIdForUpdate(client, workspaceId, id)
        if (row) lockedConversations.set(id, row)
      }

      let destination: Conversation | null = null
      if (existingDestinationId) {
        const existing = lockedConversations.get(existingDestinationId)
        if (!existing) {
          throw new HttpError("Conversation not found", { status: 404, code: "CONVERSATION_NOT_FOUND" })
        }
        if (existing.streamId !== streamId) {
          throw new HttpError("Conversation is not in this stream", {
            status: 400,
            code: "CONVERSATION_NOT_IN_STREAM",
          })
        }
        destination = existing
      }

      // Sources = every locked conversation that isn't the destination.
      const sourceRows = new Map<string, Conversation>()
      for (const [id, row] of lockedConversations) {
        if (id !== destination?.id) sourceRows.set(id, row)
      }

      // Now lock the moving rows; `findByIdsForUpdate` returns them in `sequence`
      // order — also the timeline order we preserve when appending to the dest.
      const lockedMessages = await MessageRepository.findByIdsForUpdate(client, uniqueIds)
      if (lockedMessages.length !== uniqueIds.length) {
        throw new HttpError("Some selected messages were not found", { status: 404, code: "MESSAGE_NOT_FOUND" })
      }
      const messageById = new Map(lockedMessages.map((m) => [m.id, m]))
      // A primary membership always lives in the message's own stream, and a mint
      // anchors on `streamId`; so every selected message must be in this stream.
      for (const message of lockedMessages) {
        if (message.streamId !== streamId) {
          throw new HttpError("All selected messages must belong to the same stream", {
            status: 400,
            code: "MESSAGE_NOT_IN_STREAM",
          })
        }
      }
      const orderedIds = lockedMessages.map((m) => m.id)

      // Authoritative grouping, stable now the message rows are pinned. NO further
      // conversation lock is taken here — a message already primary in the (existing)
      // dest is a no-op, and one whose primary raced into a conversation we didn't
      // pre-lock is left where it is (locking it now would be a conv lock after a
      // message lock, the one ordering that could still cycle). Nothing is ever
      // already primary in a not-yet-minted destination, so the "already there"
      // exclusion only applies to an existing target.
      const primaries = await ConversationRepository.findPrimariesByMessageIds(client, workspaceId, orderedIds)
      const existingDestId = destination?.id ?? null
      const moveIds = orderedIds.filter((id) => {
        const currentId = primaries.get(id)?.id
        if (existingDestId !== null && currentId === existingDestId) return false
        return currentId == null || sourceRows.has(currentId)
      })
      if (moveIds.length === 0) {
        if (destination) {
          // Existing target: a legitimate no-op (everything already lives there).
          const fresh = await ConversationRepository.findById(client, destination.id)
          if (!fresh) throw new Error(`Conversation ${destination.id} disappeared during reassignment`)
          return { conversation: addStalenessFields(fresh), sourceConversations: [] }
        }
        // New target with nothing left to move — every selected message was
        // reassigned out from under us between the peek and the lock. The mint is
        // deferred to exactly here, so we never created an orphan empty conversation
        // (INV-57-adjacent: no dangling row); surface a conflict instead.
        throw new HttpError("The selected messages are no longer available to move", {
          status: 409,
          code: "NO_MESSAGES_TO_MOVE",
        })
      }

      // Something to move — mint the destination now for a new target (deferred to
      // here so an all-raced-away selection above leaves no orphan row).
      if (!destination) {
        destination = await ConversationRepository.insert(client, {
          id: generateConversationId(),
          streamId,
          workspaceId,
          confidence: 1,
          status: ConversationStatuses.ACTIVE,
        })
      }
      // Non-null past the mint; bind it so the closures below keep the narrowing.
      const dest = destination

      // Group the move set by its current source (a selection can span more than
      // one). Ids with no primary yet (extraction hasn't assigned them) carry no
      // source — pure adds, recorded with a null `fromConversationId`.
      const movedBySource = new Map<string, string[]>()
      for (const id of moveIds) {
        const sourceId = primaries.get(id)?.id
        if (!sourceId) continue
        const list = movedBySource.get(sourceId)
        if (list) list.push(id)
        else movedBySource.set(sourceId, [id])
      }

      // Hydrate the authors of every message that stays in a source and every
      // message already in the destination — needed to recompute the
      // `participant_ids` we SET on the arrays below.
      const authorLookupIds = new Set<string>(moveIds)
      for (const row of sourceRows.values()) for (const id of row.messageIds) authorLookupIds.add(id)
      for (const id of destination.messageIds) authorLookupIds.add(id)
      const memberMessages = await MessageRepository.findByIds(client, [...authorLookupIds])

      // Remove moved ids from each source, recomputing that source's remaining
      // participants; resolve a source the move empties.
      for (const [sourceId, movedFromSource] of movedBySource) {
        const source = sourceRows.get(sourceId)
        if (!source) continue
        const movedSet = new Set(movedFromSource)
        const remainingIds = source.messageIds.filter((id) => !movedSet.has(id))
        await ConversationRepository.removePrimaryMessages(
          client,
          workspaceId,
          sourceId,
          movedFromSource,
          distinctAuthors(remainingIds, memberMessages)
        )
        await ConversationRepository.resolveIfEmpty(client, workspaceId, sourceId)
      }

      // One feedback row per moved message (parity with the other correction
      // paths), each recording its own source (or null) and stream (INV-56).
      await ConversationFeedbackRepository.insertMany(
        client,
        moveIds.map((id) => ({
          id: conversationFeedbackId(),
          workspaceId,
          streamId: messageById.get(id)!.streamId,
          messageId: id,
          fromConversationId: primaries.get(id)?.id ?? null,
          toConversationId: dest.id,
          userId: actorUserId,
        }))
      )

      // Add the whole move set to the destination, recomputing its FULL participant
      // list (existing members + arrivals) — `addPrimaryMessages` SETs participants,
      // so an incomplete union would drop the existing ones.
      await ConversationRepository.addPrimaryMessages(
        client,
        workspaceId,
        destination.id,
        moveIds,
        distinctAuthors([...destination.messageIds, ...moveIds], memberMessages)
      )
      await ConversationRepository.reactivateIfInactive(client, workspaceId, destination.id)

      const touchedIds = [destination.id, ...sourceRows.keys()]
      await ConversationRepository.bumpActivityForIds(client, workspaceId, touchedIds)

      // Re-read every touched row post-write so the events carry final membership.
      const finalById = new Map(
        (await ConversationRepository.findByIds(client, workspaceId, touchedIds)).map((c) => [c.id, c])
      )
      const finalDestination = finalById.get(destination.id)
      if (!finalDestination) {
        throw new Error(`Conversation ${destination.id} disappeared during reassignment`)
      }

      // Every message, source, and destination shares one stream (guarded above),
      // so one delivery resolution covers all of them (INV-62), as in
      // {@link reassignMessage}.
      const stream = await StreamRepository.findById(client, streamId)
      const { parentStreamId, streamVisibility } = await resolveConversationDelivery(client, stream)

      if (target.kind === "new") {
        await OutboxRepository.insert(client, "conversation:created", {
          workspaceId,
          streamId: finalDestination.streamId,
          conversationId: finalDestination.id,
          conversation: addStalenessFields(finalDestination),
          parentStreamId,
          streamVisibility,
        })
      }

      for (const id of touchedIds) {
        // A minted destination is carried by the `conversation:created` above;
        // emit `conversation:updated` for the existing rows only.
        if (id === destination.id && target.kind === "new") continue
        const conv = finalById.get(id)
        if (!conv) continue
        await OutboxRepository.insert(client, "conversation:updated", {
          workspaceId,
          streamId: conv.streamId,
          conversationId: conv.id,
          conversation: addStalenessFields(conv),
          parentStreamId,
          streamVisibility,
        })
      }

      // Per-message move events route to each message's own stream (for the
      // timeline membership map + extraction feedback), mirroring the other paths.
      for (const id of moveIds) {
        const fromConversationId = primaries.get(id)?.id ?? null
        if (fromConversationId) {
          await OutboxRepository.insert(client, "conversation:message_reassigned", {
            workspaceId,
            streamId: messageById.get(id)!.streamId,
            messageId: id,
            fromConversationId,
            toConversationId: destination.id,
            reason: "user_correction",
          })
        } else {
          await OutboxRepository.insert(client, "conversation:message_assigned", {
            workspaceId,
            streamId: messageById.get(id)!.streamId,
            parentStreamId,
            messageId: id,
            conversationId: destination.id,
            isPrimary: true,
            reason: "user_correction",
          })
        }
      }

      const sourceConversations = [...sourceRows.keys()]
        .map((id) => finalById.get(id))
        .filter((c): c is Conversation => c !== undefined)
        .map(addStalenessFields)

      return { conversation: addStalenessFields(finalDestination), sourceConversations }
    })
  }

  /**
   * Apply a user-confirmed AI split proposal: partition ONE conversation's
   * messages into the confirmed groups. `groups[0]` stays in the source
   * conversation (re-titled to its group); every later group is minted as a new
   * titled conversation and its messages moved in. Membership-only, like
   * {@link reassignMessagesToConversation} — no message events move, so broadcast
   * sequences and INV-61 contiguity are untouched.
   *
   * Concurrency (INV-20): the source conversation is locked BEFORE the message
   * rows (conversation-first, matching {@link reassignMessagesToConversation} and
   * {@link splitThreadIntoConversation}); the destinations are fresh mints with no
   * pre-existing row to contend for, so the single source lock is the whole
   * conversation lock set and the order is trivially deadlock-free. Membership is
   * re-read authoritatively once the rows are pinned: a message that raced OUT of
   * the source between propose and apply is simply skipped, never yanked from
   * wherever it now lives. All member/feedback writes and outbox events commit in
   * one transaction (INV-6/7), delivered via the outbox (INV-4).
   */
  async applySplit(params: ApplySplitParams): Promise<ApplySplitResult> {
    const { workspaceId, streamId, conversationId, groups, actorUserId } = params

    return withTransaction(this.pool, async (client) => {
      const source = await ConversationRepository.findByIdForUpdate(client, workspaceId, conversationId)
      if (!source) {
        throw new HttpError("Conversation not found", { status: 404, code: "CONVERSATION_NOT_FOUND" })
      }
      if (source.streamId !== streamId) {
        throw new HttpError("Conversation is not in this stream", {
          status: 400,
          code: "CONVERSATION_NOT_IN_STREAM",
        })
      }

      const allIds = [...new Set(groups.flatMap((g) => g.messageIds))]
      const lockedMessages = await MessageRepository.findByIdsForUpdate(client, allIds)
      if (lockedMessages.length !== allIds.length) {
        throw new HttpError("Some selected messages were not found", { status: 404, code: "MESSAGE_NOT_FOUND" })
      }
      const messageById = new Map(lockedMessages.map((m) => [m.id, m]))
      for (const message of lockedMessages) {
        if (message.streamId !== streamId) {
          throw new HttpError("All selected messages must belong to the same stream", {
            status: 400,
            code: "MESSAGE_NOT_IN_STREAM",
          })
        }
      }

      // Authoritative membership now the rows are pinned: only messages still
      // primary in the source are moved; movers that raced out are skipped.
      const primaries = await ConversationRepository.findPrimariesByMessageIds(client, workspaceId, allIds)
      const inSource = new Set(allIds.filter((id) => primaries.get(id)?.id === source.id))

      // groups[0] stays in the source; later groups mint. Filter each moved group
      // to messages still in the source and drop groups left empty.
      const [keepGroup, ...restGroups] = groups
      const moveGroups = restGroups
        .map((g) => ({ ...g, messageIds: g.messageIds.filter((id) => inSource.has(id)) }))
        .filter((g) => g.messageIds.length > 0)

      if (moveGroups.length === 0) {
        // Every message that would have moved raced out from under us (or the
        // split collapsed to one group). Nothing to do — surface a conflict rather
        // than silently re-titling the source to a stale proposal.
        throw new HttpError("The selected messages are no longer available to split", {
          status: 409,
          code: "NO_MESSAGES_TO_MOVE",
        })
      }

      const movingIds = moveGroups.flatMap((g) => g.messageIds)
      const movingSet = new Set(movingIds)
      const remainingSourceIds = source.messageIds.filter((id) => !movingSet.has(id))

      // Re-title the source to the kept group ONLY when the proposal accounted for
      // the whole source. A proposal can cover a subset — the split window caps how
      // many messages the model sees (see MAX_SPLIT_MESSAGES), or a message arrived
      // after the proposal — leaving un-analyzed messages in the source; the kept
      // group's title describes only the analyzed slice, so it would misdescribe the
      // remainder. In that case keep the source's existing title.
      const analyzedIds = new Set(groups.flatMap((g) => g.messageIds))
      const sourceFullyAnalyzed = source.messageIds.every((id) => analyzedIds.has(id))

      // Authors for the participant recompute: everything staying in the source
      // plus every moved message (each mint SETs its own participant list).
      const authorLookupIds = new Set<string>([...source.messageIds, ...movingIds])
      const memberMessages = await MessageRepository.findByIds(client, [...authorLookupIds])

      // Strip movers from the source, recompute its remaining participants, and
      // (when the whole source was analyzed) re-title it to the kept group; resolve
      // it if the split emptied it.
      await ConversationRepository.removePrimaryMessages(
        client,
        workspaceId,
        source.id,
        movingIds,
        distinctAuthors(remainingSourceIds, memberMessages)
      )
      if (sourceFullyAnalyzed) {
        await ConversationRepository.update(client, workspaceId, source.id, {
          topicSummary: keepGroup.title,
          summary: keepGroup.summary,
        })
      }
      await ConversationRepository.resolveIfEmpty(client, workspaceId, source.id)

      // Mint one titled conversation per moved group, tracking where each id lands
      // for the feedback rows.
      const movedTo = new Map<string, string>()
      const mintedIds: string[] = []
      for (const g of moveGroups) {
        const minted = await ConversationRepository.insert(client, {
          id: generateConversationId(),
          streamId,
          workspaceId,
          topicSummary: g.title,
          summary: g.summary,
          confidence: 1,
          status: ConversationStatuses.ACTIVE,
        })
        await ConversationRepository.addPrimaryMessages(
          client,
          workspaceId,
          minted.id,
          g.messageIds,
          distinctAuthors(g.messageIds, memberMessages)
        )
        mintedIds.push(minted.id)
        for (const id of g.messageIds) movedTo.set(id, minted.id)
      }

      // One feedback row per moved message (parity with the other correction paths).
      await ConversationFeedbackRepository.insertMany(
        client,
        movingIds.map((id) => ({
          id: conversationFeedbackId(),
          workspaceId,
          streamId: messageById.get(id)!.streamId,
          messageId: id,
          fromConversationId: source.id,
          toConversationId: movedTo.get(id)!,
          userId: actorUserId,
        }))
      )

      const touchedIds = [source.id, ...mintedIds]
      await ConversationRepository.bumpActivityForIds(client, workspaceId, touchedIds)

      // Re-read every touched row post-write so the events carry final membership.
      const finalById = new Map(
        (await ConversationRepository.findByIds(client, workspaceId, touchedIds)).map((c) => [c.id, c])
      )
      const finalSource = finalById.get(source.id)
      if (!finalSource) {
        throw new Error(`Conversation ${source.id} disappeared during split`)
      }

      // Everything shares one stream (guarded above), so one delivery resolution
      // covers every event (INV-62), as in {@link reassignMessagesToConversation}.
      const stream = await StreamRepository.findById(client, streamId)
      const { parentStreamId, streamVisibility } = await resolveConversationDelivery(client, stream)

      for (const mintedId of mintedIds) {
        const minted = finalById.get(mintedId)
        if (!minted) continue
        await OutboxRepository.insert(client, "conversation:created", {
          workspaceId,
          streamId: minted.streamId,
          conversationId: minted.id,
          conversation: addStalenessFields(minted),
          parentStreamId,
          streamVisibility,
        })
      }

      await OutboxRepository.insert(client, "conversation:updated", {
        workspaceId,
        streamId: finalSource.streamId,
        conversationId: finalSource.id,
        conversation: addStalenessFields(finalSource),
        parentStreamId,
        streamVisibility,
      })

      // Per-message move events route to each message's own stream (for the
      // timeline membership map + extraction feedback), mirroring the other paths.
      for (const id of movingIds) {
        await OutboxRepository.insert(client, "conversation:message_reassigned", {
          workspaceId,
          streamId: messageById.get(id)!.streamId,
          messageId: id,
          fromConversationId: source.id,
          toConversationId: movedTo.get(id)!,
          reason: "user_correction",
        })
      }

      const newConversations = mintedIds
        .map((id) => finalById.get(id))
        .filter((c): c is Conversation => c !== undefined)
        .map(addStalenessFields)

      logger.info(
        { conversationId: source.id, movedGroups: moveGroups.length, movedMessages: movingIds.length },
        "Conversation split applied"
      )
      return { conversation: addStalenessFields(finalSource), newConversations }
    })
  }

  /**
   * Mark a conversation read through `throughMessageId` (inclusive). Read truth is
   * message-granular and stream-anchored (docs/sparse-read-overlay-design.md):
   * the conversation's member messages are snapshotted to concrete ids at write
   * time (immune to later re-clustering), grouped by each message's own stream (a
   * conversation spans root + threads), and applied as a sparse-read overlay per
   * stream — compacting into the watermark where contiguous. One transaction
   * (INV-6), one `stream:read_messages` per touched stream (INV-4/7).
   */
  async markRead(params: {
    workspaceId: string
    conversationId: string
    throughMessageId: string
    userId: string
  }): Promise<{ streams: ReadStateSnapshot[] }> {
    return withTransaction(this.pool, async (client) => {
      const groups = await this.resolveConversationReadTargets(
        client,
        params.workspaceId,
        params.conversationId,
        params.throughMessageId,
        "read"
      )
      const streams: ReadStateSnapshot[] = []
      for (const [streamId, messageIds] of groups) {
        streams.push(
          await applySparseRead(client, {
            workspaceId: params.workspaceId,
            streamId,
            memberId: params.userId,
            messageIds,
          })
        )
      }
      // Message-granular activity coupling: reading these messages clears their
      // activity rows (mention/reply badges) — and only theirs, so the stream's
      // other topics keep their badges. One batched update across all streams.
      await ActivityRepository.markMessagesAsRead(
        client,
        params.workspaceId,
        params.userId,
        groups.flatMap(([, messageIds]) => messageIds)
      )
      return { streams }
    })
  }

  /**
   * Mark a conversation unread from `fromMessageId` (inclusive). Per spanned
   * stream: drop the affected member ids from the overlay and regress the
   * watermark to just before the earliest affected message when it sits at/past
   * it (existing `stream:read_set` semantics, accepting collateral un-reading).
   */
  async markUnread(params: {
    workspaceId: string
    conversationId: string
    fromMessageId: string
    userId: string
  }): Promise<{ streams: ReadStateSnapshot[] }> {
    return withTransaction(this.pool, async (client) => {
      const groups = await this.resolveConversationReadTargets(
        client,
        params.workspaceId,
        params.conversationId,
        params.fromMessageId,
        "unread"
      )
      const streams: ReadStateSnapshot[] = []
      for (const [streamId, messageIds] of groups) {
        streams.push(
          await applySparseUnread(client, {
            workspaceId: params.workspaceId,
            streamId,
            memberId: params.userId,
            messageIds,
          })
        )
      }
      return { streams }
    })
  }

  /**
   * Resolve a conversation's member messages to the concrete ids to apply per
   * stream: `message_ids ∪ secondary_message_ids` plus the thread-anchored
   * opening's parent message, filtered by the target message's `createdAt`
   * (timestamps are the card's cross-stream merge key — sequences aren't
   * comparable across streams). Returns `[streamId, messageIds]` entries in
   * sorted stream-id order so two concurrent conversation-reads take the same
   * per-stream lock order and can't deadlock.
   */
  private async resolveConversationReadTargets(
    client: Querier,
    workspaceId: string,
    conversationId: string,
    targetMessageId: string,
    direction: "read" | "unread"
  ): Promise<Array<[string, string[]]>> {
    const conversation = await ConversationRepository.findById(client, conversationId)
    if (!conversation || conversation.workspaceId !== workspaceId) {
      throw new HttpError("Conversation not found", { status: 404, code: "CONVERSATION_NOT_FOUND" })
    }

    const memberSet = new Set<string>([...conversation.messageIds, ...conversation.secondaryMessageIds])
    const stream = await StreamRepository.findById(client, conversation.streamId)
    if (stream?.type === StreamTypes.THREAD && stream.parentAnchorId?.startsWith("msg_")) {
      memberSet.add(stream.parentAnchorId)
    }

    // The target must be one of the conversation's concrete member messages
    // (including the thread-opening parent added above). A foreign id — a
    // message that exists but isn't part of this conversation — must not supply
    // the cross-stream cutoff timestamp (it would read/unread an arbitrary span
    // of the conversation). Reject before any resolution or write.
    if (!memberSet.has(targetMessageId)) {
      throw new HttpError("Message not found", { status: 404, code: "MESSAGE_NOT_FOUND" })
    }

    const messagesMap = await MessageRepository.findByIds(client, [...memberSet])

    const target = messagesMap.get(targetMessageId)
    if (!target) {
      throw new HttpError("Message not found", { status: 404, code: "MESSAGE_NOT_FOUND" })
    }
    const cutoff = target.createdAt.getTime()

    const groups = new Map<string, string[]>()
    for (const id of memberSet) {
      const message = messagesMap.get(id)
      if (!message) continue
      const at = message.createdAt.getTime()
      const include = direction === "read" ? at <= cutoff : at >= cutoff
      if (!include) continue
      const list = groups.get(message.streamId)
      if (list) list.push(id)
      else groups.set(message.streamId, [id])
    }

    // Boundary guard: every distinct stream the resolved messages live in must
    // belong to this workspace and resolve (INV-62) to the same effective root
    // as the conversation. A stale/corrupt member pointing at a foreign stream
    // (cross-workspace, or a different thread root) must not be written. Runs
    // over distinct streams only (one batch lookup, not per-message) and BEFORE
    // any applySparseRead/Unread write.
    const conversationRoot = stream?.rootStreamId ?? conversation.streamId
    const memberStreams = await StreamRepository.findByIds(client, [...groups.keys()])
    const memberStreamById = new Map(memberStreams.map((s) => [s.id, s]))
    for (const memberStreamId of groups.keys()) {
      const memberStream = memberStreamById.get(memberStreamId)
      // A missing row, a cross-workspace stream, or a stream whose effective
      // root (thread → root, same rule as `effectiveRootId`) differs from the
      // conversation's root is foreign to this conversation.
      if (
        !memberStream ||
        memberStream.workspaceId !== workspaceId ||
        (memberStream.rootStreamId ?? memberStream.id) !== conversationRoot
      ) {
        throw new HttpError("Message not found", { status: 404, code: "MESSAGE_NOT_FOUND" })
      }
    }

    // Map keys are unique, so a strict less-than comparator totally orders them.
    return [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1))
  }
}

/** Distinct non-null author ids of `ids`, in first-appearance order — the
 *  recomputed `participant_ids` for a membership move. */
function distinctAuthors(ids: string[], messages: Map<string, Message>): string[] {
  const seen = new Set<string>()
  const authors: string[] = []
  for (const id of ids) {
    const authorId = messages.get(id)?.authorId
    if (authorId && !seen.has(authorId)) {
      seen.add(authorId)
      authors.push(authorId)
    }
  }
  return authors
}

/** Project a full message + its hydrated rich content down to a board post message. */
function toBoardPostMessage(
  message: Message,
  attachments: AttachmentSummary[],
  linkPreviews: LinkPreviewSummary[]
): BoardPostMessage {
  return {
    id: message.id,
    streamId: message.streamId,
    authorId: message.authorId,
    authorType: message.authorType,
    contentMarkdown: message.contentMarkdown,
    reactions: message.reactions,
    attachments,
    linkPreviews,
    createdAt: message.createdAt,
    editedAt: message.editedAt,
  }
}
