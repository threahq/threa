import { useEffect } from "react"
import { toast } from "sonner"
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  useConversationService,
  useMessageService,
  useSocket,
  useSocketReconnectCount,
  createDraftPanelId,
} from "@/contexts"
import { db } from "@/db"
import { useWorkspaceStreams } from "@/stores/workspace-store"
import { useOptionalSyncEngine } from "@/sync/sync-engine"
import { seedBoardPosts, useBoardPost, mergeBoardConversation, putOptimisticBoardPost } from "@/stores/board-store"
import { seedBoardExclusions, putHidden, deleteHidden, putMuted, deleteMuted } from "@/stores/board-exclusions-store"
import type { BoardViewPost } from "./use-stable-board-view"
import { useDraftScratchpads } from "./use-draft-scratchpads"
import { useQueueDraftMessage } from "./use-queue-draft-message"
import { generateClientId } from "./use-stream-or-draft"
import { generateConversationId } from "@/lib/ids"
import { serializeToMarkdown } from "@threa/prosemirror"
import { type AttachmentSummary } from "./create-optimistic-bootstrap"
import type { SplitGroupInput } from "@/api/conversations"
import { StreamTypes } from "@threa/types"
import type {
  BoardLens,
  BoardPost,
  BoardScopeStreamType,
  CompanionMode,
  ComposeTrace,
  ConversationWithStaleness,
  ConversationStatus,
  JSONContent,
} from "@threa/types"

/**
 * Where a board post lands: an existing channel/DM the user picked, or a
 * brand-new scratchpad created for the post (`companionMode` distinguishes a
 * companion AI scratchpad from a plain quick note).
 */
export type BoardPostTarget =
  | { type: "stream"; streamId: string }
  | { type: "newScratchpad"; companionMode: CompanionMode }

export interface CreateBoardPostInput {
  target: BoardPostTarget
  contentJson: JSONContent
  attachmentIds?: string[]
  /** Full attachment summaries (not just ids) so the optimistic card renders
   *  thumbnails immediately instead of popping them in on refetch. */
  attachments?: AttachmentSummary[]
}

/** Shared stable empty list so a disabled/loading query returns one identity. */
const EMPTY_CONVERSATIONS: ConversationWithStaleness[] = []

/**
 * The conversation's most-recently-active stream from its board projection: the
 * newest recent-message's own stream (a thread under the root — recency-biased
 * continuation, board-view-design.md), falling back to the conversation anchor.
 * `recentMessages` is optional-chained because older cached `conversations` IDB
 * rows predate the field. This is the projection-derived answer used where the
 * live message rail isn't loaded (the timeline composer); the conversation panel
 * refines it from its live merged `displayedReplies` once the rail is present.
 */
export function boardPostLastActiveStreamId(post: Pick<BoardPost, "recentMessages" | "conversation">): string {
  return post.recentMessages?.at(-1)?.streamId ?? post.conversation.streamId
}

export const conversationKeys = {
  all: ["conversations"] as const,
  list: (workspaceId: string, streamId: string, options?: { status?: string; limit?: number }) =>
    [...conversationKeys.all, "list", workspaceId, streamId, options ?? {}] as const,
  workspaceList: (
    workspaceId: string,
    options?: {
      status?: string
      lens?: string
      streams?: string[]
      types?: string[]
      excludeStreams?: string[]
      excludeTypes?: string[]
      labels?: string[]
      excludeLabels?: string[]
      showArchived?: boolean
      limit?: number
    }
  ) => [...conversationKeys.all, "workspaceList", workspaceId, options ?? {}] as const,
  byId: (workspaceId: string, conversationId: string) =>
    [...conversationKeys.all, "detail", workspaceId, conversationId] as const,
  messages: (conversationId: string) => ["conversations", conversationId, "messages"] as const,
  boardMessages: (conversationId: string) => ["conversations", conversationId, "board-messages"] as const,
  boardPost: (conversationId: string) => ["conversations", conversationId, "board-post"] as const,
}

interface ConversationCreatedPayload {
  workspaceId: string
  streamId: string
  conversation: ConversationWithStaleness
  /** For thread conversations, the parent channel's stream ID */
  parentStreamId?: string
}

interface ConversationUpdatedPayload {
  workspaceId: string
  streamId: string
  conversationId: string
  conversation: ConversationWithStaleness
  /** For thread conversations, the parent channel's stream ID */
  parentStreamId?: string
}

interface ConversationMessageAssignedPayload {
  workspaceId: string
  streamId: string
  messageId: string
  conversationId: string
  isPrimary: boolean
  reason: string
  /** For thread messages, the parent channel's stream ID. */
  parentStreamId?: string
}

interface ConversationMessageReassignedPayload {
  workspaceId: string
  streamId: string
  messageId: string
  fromConversationId: string
  toConversationId: string
  reason: string
}

interface UseConversationsOptions {
  status?: ConversationStatus
  limit?: number
  enabled?: boolean
}

/**
 * Cross-stream conversation feed for the workspace board, keyset-paginated.
 *
 * This is the board's FETCH/SEED engine, not its read authority: every fetched
 * page is written into the `conversations` IDB store (subscribe-then-fetch,
 * INV-53), and the board renders reactively from IDB via `useBoardPosts` — the
 * same rails the timeline rides. Live `conversation:*` events (gate-applied in
 * `registerWorkspaceSocketHandlers`) and optimistic writes re-sort the IDB feed
 * in place without a refetch; this query just keeps the head fresh on open and
 * pages older cards in. `refetchOnReconnect` is left ON as the catch-up backstop
 * for the unsynced board surface.
 */
export function useWorkspaceConversations(
  workspaceId: string,
  options?: {
    status?: ConversationStatus
    lens?: BoardLens
    streams?: string[]
    types?: BoardScopeStreamType[]
    excludeStreams?: string[]
    excludeTypes?: BoardScopeStreamType[]
    labels?: string[]
    excludeLabels?: string[]
    showArchived?: boolean
    limit?: number
  }
) {
  const conversationService = useConversationService()
  const { status, lens, limit, showArchived } = options ?? {}
  // Canonicalize the scopes for the query key: order-insensitive, and re-split
  // so the key holds stable primitive-derived arrays rather than the caller's
  // per-render array identities.
  const canonList = (list: string[] | undefined): string[] | undefined =>
    list && list.length > 0 ? [...list].sort().join(",").split(",") : undefined
  const streams = canonList(options?.streams)
  const types = canonList(options?.types) as BoardScopeStreamType[] | undefined
  const excludeStreams = canonList(options?.excludeStreams)
  const excludeTypes = canonList(options?.excludeTypes) as BoardScopeStreamType[] | undefined
  const labels = canonList(options?.labels)
  const excludeLabels = canonList(options?.excludeLabels)

  const query = useInfiniteQuery({
    queryKey: conversationKeys.workspaceList(workspaceId, {
      status,
      lens,
      streams,
      types,
      excludeStreams,
      excludeTypes,
      labels,
      excludeLabels,
      showArchived,
      limit,
    }),
    queryFn: ({ pageParam }) =>
      conversationService.listByWorkspace(workspaceId, {
        status,
        lens,
        streams,
        types,
        excludeStreams,
        excludeTypes,
        labels,
        excludeLabels,
        showArchived,
        limit,
        cursor: pageParam,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: Infinity,
    refetchOnMount: true,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
    enabled: !!workspaceId,
  })

  // Seed IDB from whatever pages are loaded so the reactive board reflects the
  // server snapshot. `bulkPut` reconciles cards in place — it never clears rows
  // a page omits, so live/optimistic rows outside the fetched window survive.
  const { data } = query
  useEffect(() => {
    if (!data) return
    void seedBoardPosts(
      workspaceId,
      data.pages.flatMap((page) => page.posts)
    )
  }, [data, workspaceId])

  return query
}

/**
 * Author a board post through the STANDARD message send — a post is just a
 * message; there is no board-specific endpoint.
 *
 *  - Existing channel/DM: declare a fresh conversation
 *    (`conversation: { intent: "new" }`), which the backend creates synchronously
 *    in the send's transaction so the board reflects it immediately. The send
 *    carries a `clientMessageId` so a retried request can't double-post.
 *  - New scratchpad / quick note: reuse the same draft-scratchpad +
 *    promote-on-send components the sidebar uses (`createScratchpad` +
 *    `queueDraftMessage`). The server scratchpad row is born WITH its first
 *    message via `promoteDraft` — never created empty — and the durable queue
 *    keys the send by clientId (idempotent on retry). A fresh scratchpad's first
 *    message is trivially a new conversation, which the boundary extractor mints,
 *    so no directive is needed on this path.
 *
 * On success the board feed is invalidated so the just-created conversation
 * appears (the board has no socket subscription yet).
 */
export function useCreateBoardPost(workspaceId: string) {
  const messageService = useMessageService()
  const { createScratchpad } = useDraftScratchpads(workspaceId)
  const { queueDraftMessage, currentUserId } = useQueueDraftMessage(workspaceId)
  const queryClient = useQueryClient()
  const streams = useWorkspaceStreams(workspaceId)

  return useMutation({
    mutationFn: async ({ target, contentJson, attachmentIds, attachments }: CreateBoardPostInput) => {
      if (target.type === "newScratchpad") {
        const draftId = await createScratchpad(target.companionMode)
        // Mint the conversation id up front so the card can land the instant the
        // composer clears (below) and the send honors the same id — the card
        // reconciles by it, no promote+send wait, no temp-id swap.
        const conversationId = generateConversationId()
        const { clientId } = await queueDraftMessage(
          { contentJson, attachmentIds, attachments },
          {
            workspaceId,
            streamId: draftId,
            streamCreation: { type: StreamTypes.SCRATCHPAD, companionMode: target.companionMode },
            draftId,
            // Declare the fresh conversation with our client-minted id so the
            // promote-on-send backend assigns it synchronously (honoring the id)
            // instead of leaving it to the async extractor. `intent: "new"` because
            // an authored post is always a new topic boundary.
            conversation: { intent: "new", conversationId },
          }
        )

        // Slot the card at composer-clear, keyed by the minted conversation id —
        // a new scratchpad post appears immediately, like a timeline optimistic
        // message, rather than after the promote+send round-trips. It's a stub
        // under the DRAFT stream id (rootStreamType scratchpad); the queue drain
        // refines it with the real stream/message ids + server-resolved markdown
        // post-promotion, and the echo/refetch clears `_status` — all by the same
        // id. Best-effort: a local IDB failure must not fail the send. A cancelled
        // send drops the stub via `deleteOptimisticBoardPost` (see deleteMessage).
        if (currentUserId) {
          try {
            await putOptimisticBoardPost(workspaceId, {
              conversationId,
              messageId: clientId,
              streamId: draftId,
              authorId: currentUserId,
              contentMarkdown: serializeToMarkdown(contentJson),
              rootStreamId: draftId,
              rootStreamType: StreamTypes.SCRATCHPAD,
              createdAt: new Date().toISOString(),
              attachments,
            })
          } catch (err) {
            console.error("Failed to seed optimistic board post at composer-clear", err)
          }
        }
        return conversationId
      }

      const { message, conversationId } = await messageService.create(workspaceId, target.streamId, {
        streamId: target.streamId,
        contentJson,
        attachmentIds,
        clientMessageId: generateClientId(),
        conversation: { intent: "new" },
      })

      // Slot the card the instant the send returns, keyed by the real conversation
      // id the backend minted synchronously — so it's on screen as the composer
      // clears, not after the echo + board-head refetch. Reconciled in place by
      // both (same id, `_status` cleared). A channel/DM is its own effective root.
      // Best-effort: the message is already committed server-side, so a local IDB
      // write failure must not fail the send (which would risk a duplicate resend).
      const stream = streams.find((s) => s.id === target.streamId)
      if (conversationId && currentUserId && stream) {
        try {
          await putOptimisticBoardPost(workspaceId, {
            conversationId,
            messageId: message.id,
            streamId: target.streamId,
            authorId: currentUserId,
            // Server-resolved markdown (mentions → ids, INV-64), not a client
            // re-serialize that could show a bare `@slug` until reconcile — matches
            // the drain path.
            contentMarkdown: message.contentMarkdown,
            rootStreamId: stream.rootStreamId ?? stream.id,
            rootStreamType: stream.type as BoardScopeStreamType,
            createdAt: message.createdAt,
            attachments,
          })
        } catch (err) {
          console.error("Failed to seed optimistic board post", err)
        }
      }
      return conversationId
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...conversationKeys.all, "workspaceList", workspaceId] })
    },
  })
}

export interface ReplyToBoardPostInput {
  /** The post's conversation — supplies the host stream and the attach target. */
  conversation: Pick<ConversationWithStaleness, "id" | "streamId">
  /** The post's opening message id — the thread parent for a lone-message reply. */
  openingMessageId: string | null
  /** Host stream type (`channel` | `dm` | `scratchpad` | `thread` | undefined). */
  hostStreamType: string | undefined
  /** Count of messages in the conversation, deciding the lone-root case. */
  messageCount: number
  /**
   * The conversation's most-recently-active stream — its latest message's stream
   * (a conversation can span its root + threads, one root). A continuation targets
   * this, not the anchor: once a conversation has moved into a thread, replying in
   * the root would re-interleave the channel (board-view-design.md "Continuation
   * is recency-biased"). Omit to fall back to the conversation's anchor stream.
   */
  lastActiveStreamId?: string | null
  contentJson: JSONContent
  attachmentIds?: string[]
  /** Full attachment info for the optimistic event so files render in place. */
  attachments?: AttachmentSummary[]
  /** Compose-session provenance for this send (see {@link ComposeTrace}). */
  composeTrace?: ComposeTrace
}

/**
 * Where a board reply lands. Replying from the board joins the conversation, but
 * a conversation that is still a lone message (a fresh post, no back-and-forth)
 * in a channel or DM has no established shape — so the reply converts it into a
 * thread, keeping the parent stream's top level clean (one opener, the exchange
 * underneath) instead of sprouting interleaved flat replies (user ruling):
 *
 *  - **lone message in a channel or DM** (≤1 message, has an opening id) →
 *    `convertToThread`: thread off the opener (it stays in the parent stream as
 *    the thread's root). The reply joins the SAME conversation as a cross-stream
 *    member (root opener + thread reply, one root — board-view-design.md), so the
 *    board keeps showing one card and the reply renders in place; no card swap.
 *  - **everything else** → flat into the conversation's most-recently-active
 *    stream via the `existing` directive: an established channel/DM conversation
 *    stays where it is, a thread card replies into its thread, a scratchpad stays
 *    flat. A deleted opener (no id) can't be threaded, so it stays flat too.
 */
export type BoardReplyPlan = { kind: "convertToThread"; parentMessageId: string } | { kind: "intoConversation" }

export function planBoardReply(input: {
  hostStreamType: string | undefined
  messageCount: number
  openingMessageId: string | null
}): BoardReplyPlan {
  const threadable = input.hostStreamType === StreamTypes.CHANNEL || input.hostStreamType === StreamTypes.DM
  if (threadable && input.messageCount <= 1 && input.openingMessageId) {
    return { kind: "convertToThread", parentMessageId: input.openingMessageId }
  }
  return { kind: "intoConversation" }
}

/**
 * Reply to a board post from the feed, routed by {@link planBoardReply}. Eager
 * and offline-first: the reply is written as an optimistic `message_created`
 * event into the same `db.events` rail the card reads (and a durable pending row
 * the background queue drains), so it shows the instant the user sends — no
 * round-trip — exactly like a stream send. The server echo swaps the optimistic
 * event for the real one. Returns the resolved plan for the caller. Both kinds
 * render in place: a `convertToThread` reply lands in a thread off the opener but
 * joins the SAME conversation (no card swap), and an `intoConversation` reply
 * attaches to the conversation directly — each is tagged with the conversation so
 * it shows under the card that produced it (see `useQueueDraftMessage` /
 * `useBoardCardMessages`).
 */
export function useReplyToBoardPost(workspaceId: string) {
  const { queueDraftMessage } = useQueueDraftMessage(workspaceId)

  return useMutation({
    mutationFn: async ({
      conversation,
      openingMessageId,
      hostStreamType,
      messageCount,
      lastActiveStreamId,
      contentJson,
      attachmentIds,
      attachments,
      composeTrace,
    }: ReplyToBoardPostInput): Promise<{ plan: BoardReplyPlan }> => {
      const input = {
        contentJson,
        attachmentIds: attachmentIds && attachmentIds.length > 0 ? attachmentIds : undefined,
        attachments: attachments && attachments.length > 0 ? attachments : undefined,
        composeTrace,
      }

      const plan = planBoardReply({ hostStreamType, messageCount, openingMessageId })

      if (plan.kind === "convertToThread") {
        // Promote a draft thread off the opener, mirroring the timeline's
        // thread-reply path (`stream-panel.tsx`): the queue create-or-finds the
        // thread (idempotent server-side on (parentStreamId, parentMessageId))
        // then sends into it. The `threadFromMessage` directive attaches this reply
        // to the SAME source conversation as a cross-stream member (root opener +
        // thread reply, one root), so the board keeps one card and the reply renders
        // in place. A lone channel/DM root is never E2E, so no sealing.
        const panelId = createDraftPanelId(conversation.streamId, plan.parentMessageId)
        await queueDraftMessage(input, {
          workspaceId,
          streamId: panelId,
          streamCreation: {
            type: StreamTypes.THREAD,
            parentStreamId: conversation.streamId,
            parentAnchorId: plan.parentMessageId,
          },
          draftId: panelId,
          conversation: { intent: "threadFromMessage", sourceConversationId: conversation.id },
        })
        return { plan }
      }

      // Recency-biased continuation: target the conversation's most-recently-active
      // stream (the thread, if it has moved there), not its anchor — posting into
      // the anchor root would re-interleave the channel a convert avoided
      // (board-view-design.md). The same-root `existing` guard accepts a reply from
      // any stream under the conversation's root.
      await queueDraftMessage(input, {
        workspaceId,
        streamId: lastActiveStreamId ?? conversation.streamId,
        conversation: { intent: "existing", conversationId: conversation.id },
      })
      return { plan }
    },
  })
}

function toBoardViewPost(workspaceId: string, post: BoardPost): BoardViewPost {
  const ms = Date.parse(post.conversation.lastActivityAt)
  return {
    ...post,
    id: post.conversation.id,
    workspaceId,
    _lastActivityMs: Number.isNaN(ms) ? 0 : ms,
    _cachedAt: Date.now(),
  }
}

export interface ConversationBoardPost {
  /** The post projection for the conversation panel, or null until it resolves. */
  post: BoardViewPost | null
  /** True only before any source (the reactive store or the by-id fetch) resolves. */
  isLoading: boolean
  /** The conversation couldn't be found — gone, emptied, or not readable. */
  notFound: boolean
  refetch: () => void
}

/**
 * The board post backing the conversation side panel (Mechanism B), reachable by
 * id from any surface. Prefers the reactive board-store row — already live and
 * already feeding the board — and falls back to a by-id fetch when the panel is
 * opened without the board feed having seeded it (a `/s/:id` deep-link or the
 * in-stream conversation list). The fetched projection is held in query cache,
 * NOT seeded into the board store, so opening a conversation panel never surfaces
 * a spurious card / "N new" bump on the board. Either way the panel body reads
 * live message rows off the `db.events` rail (use-board-card-messages), so a
 * synthesized projection still fills in and patches in place.
 */
export function useConversationBoardPost(workspaceId: string, conversationId: string | null): ConversationBoardPost {
  const conversationService = useConversationService()
  const cached = useBoardPost(conversationId)
  // Fetch only once the store has resolved to genuinely no row (`null`, not the
  // still-loading `undefined`) — a card already on the board never round-trips.
  const shouldFetch = !!conversationId && cached === null

  const {
    data: fetched,
    isLoading: fetchLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: conversationId ? conversationKeys.boardPost(conversationId) : conversationKeys.boardPost("none"),
    queryFn: () => conversationService.getBoardPost(workspaceId, conversationId!),
    enabled: shouldFetch,
    staleTime: 60_000,
  })

  if (cached) return { post: cached, isLoading: false, notFound: false, refetch: () => void refetch() }
  if (fetched)
    return {
      post: toBoardViewPost(workspaceId, fetched),
      isLoading: false,
      notFound: false,
      refetch: () => void refetch(),
    }
  // A 404 (gone/empty/cross-workspace) resolves the load as not-found, not a spinner.
  const notFound = shouldFetch && isError
  const isLoading = cached === undefined || (shouldFetch && fetchLoading)
  return { post: null, isLoading, notFound, refetch: () => void refetch() }
}

export function useConversations(workspaceId: string, streamId: string, options?: UseConversationsOptions) {
  const { status, limit, enabled = true } = options ?? {}
  const conversationService = useConversationService()
  const queryClient = useQueryClient()
  const socket = useSocket()
  const reconnectCount = useSocketReconnectCount()
  // Optional: conversation overlays can mount outside the workspace SyncEngine provider.
  const syncEngine = useOptionalSyncEngine()

  const {
    // Stable empty fallback: a fresh `[]` here would change identity every
    // render while the query is disabled/loading, defeating downstream
    // `useMemo`s keyed on the list (e.g. the overlay model rebuild) and
    // re-rendering every consumer of the derived map.
    data: conversations = EMPTY_CONVERSATIONS,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: conversationKeys.list(workspaceId, streamId, { status, limit }),
    queryFn: () => conversationService.listByStream(workspaceId, streamId, { status, limit }),
    enabled: enabled && !!workspaceId && !!streamId,
    // Reconnect-driven refetch is owned by the INV-53 effect below, which
    // listens to socket reconnects (the authoritative signal — a socket can
    // resubscribe without `navigator.onLine` flipping). Suppress TanStack's
    // network-online refetch so a coincident wake-from-sleep doesn't fire two
    // HTTP requests for the same recovery.
    refetchOnReconnect: false,
  })

  // INV-53: invalidate bootstrap on resubscribe (reconnect) so any events
  // missed during the disconnect are reconciled from the server.
  //
  // When a SyncEngine is mounted its workspace catch-up cursor replays the
  // missed conversation events (stream-scoped sync-log entries) through the
  // gate-registered handlers, so the blanket invalidation is redundant there.
  // Mounts outside the SyncEngine provider (no engine) keep this healing.
  useEffect(() => {
    if (reconnectCount === 0 || !workspaceId || !streamId || !enabled) return
    if (syncEngine) return
    queryClient.invalidateQueries({ queryKey: conversationKeys.list(workspaceId, streamId, { status, limit }) })
  }, [reconnectCount, workspaceId, streamId, status, limit, enabled, queryClient, syncEngine])

  useEffect(() => {
    if (!socket || !workspaceId || !streamId || !enabled) return

    const handleCreated = (payload: ConversationCreatedPayload) => {
      // Accept events for this stream OR thread conversations whose parent is this stream
      if (payload.streamId !== streamId && payload.parentStreamId !== streamId) return

      queryClient.setQueryData(
        conversationKeys.list(workspaceId, streamId, { status, limit }),
        (old: ConversationWithStaleness[] | undefined) => {
          if (!old) return [payload.conversation]
          if (old.some((c) => c.id === payload.conversation.id)) return old
          return [...old, payload.conversation]
        }
      )
    }

    const handleUpdated = (payload: ConversationUpdatedPayload) => {
      // Accept events for this stream OR thread conversations whose parent is this stream
      if (payload.streamId !== streamId && payload.parentStreamId !== streamId) return

      queryClient.setQueryData(
        conversationKeys.list(workspaceId, streamId, { status, limit }),
        (old: ConversationWithStaleness[] | undefined) => {
          if (!old) return old
          // For thread conversations viewed from parent channel, add if not present
          const exists = old.some((c) => c.id === payload.conversationId)
          if (!exists) {
            return [...old, payload.conversation]
          }
          return old.map((c) => (c.id === payload.conversationId ? payload.conversation : c))
        }
      )
    }

    // Per-message membership updates. The conversation aggregate (with the
    // updated messageIds/secondaryMessageIds arrays) already flows through
    // `conversation:updated` for the touched conv(s), so the list shape is
    // refreshed by `handleUpdated` above. These finer-grained events drive
    // the per-conv messages query — when a message is added or moved, the
    // expanded `ConversationMessages` panel needs to refetch so its row set
    // reflects the new membership.
    const handleMessageAssigned = (payload: ConversationMessageAssignedPayload) => {
      if (payload.streamId !== streamId && payload.parentStreamId !== streamId) return
      // Reflect the new membership in the list aggregate immediately so the
      // message→conversation map (and "Show in conversation") updates from this
      // per-message event, not only when the heavier `conversation:updated`
      // aggregate replace lands. Idempotent: skip when the id is already
      // present, append to the field its primacy selects.
      queryClient.setQueryData(
        conversationKeys.list(workspaceId, streamId, { status, limit }),
        (old: ConversationWithStaleness[] | undefined) =>
          old?.map((c) => {
            if (c.id !== payload.conversationId) return c
            const field = payload.isPrimary ? "messageIds" : "secondaryMessageIds"
            if (c[field].includes(payload.messageId)) return c
            return { ...c, [field]: [...c[field], payload.messageId] }
          })
      )
      queryClient.invalidateQueries({ queryKey: conversationKeys.messages(payload.conversationId) })
    }

    const handleMessageReassigned = (payload: ConversationMessageReassignedPayload) => {
      if (payload.streamId !== streamId) return
      queryClient.invalidateQueries({ queryKey: conversationKeys.messages(payload.fromConversationId) })
      queryClient.invalidateQueries({ queryKey: conversationKeys.messages(payload.toConversationId) })
    }

    // In active sync mode, register through the engine's event gate so
    // these handlers receive catch-up replays and respect buffer-and-splice
    // ordering exactly like engine-owned handlers — conversation events are
    // stream-scoped sync-log entries, and a raw-socket registration would
    // never see them replayed after a gap.
    const eventSource = syncEngine?.getLiveEventSource() ?? socket
    eventSource.on("conversation:created", handleCreated)
    eventSource.on("conversation:updated", handleUpdated)
    eventSource.on("conversation:message_assigned", handleMessageAssigned)
    eventSource.on("conversation:message_reassigned", handleMessageReassigned)

    return () => {
      eventSource.off("conversation:created", handleCreated)
      eventSource.off("conversation:updated", handleUpdated)
      eventSource.off("conversation:message_assigned", handleMessageAssigned)
      eventSource.off("conversation:message_reassigned", handleMessageReassigned)
    }
  }, [socket, syncEngine, workspaceId, streamId, status, limit, enabled, queryClient])

  return {
    conversations,
    isLoading,
    error,
    refetch,
  }
}

/**
 * User correction from the conversation overlay: move a message's primary
 * membership to another conversation. The server response carries both
 * updated conversations, which are written straight into the list cache so
 * the overlay recolors immediately — the `conversation:updated` socket
 * events that follow are idempotent overwrites of the same rows.
 */
export function useReassignConversationMessage(workspaceId: string, streamId: string) {
  const conversationService = useConversationService()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ messageId, toConversationId }: { messageId: string; toConversationId: string }) =>
      conversationService.reassignMessage(workspaceId, toConversationId, messageId),
    onSuccess: ({ conversation, previousConversation }) => {
      const updatedById = new Map(
        [conversation, ...(previousConversation ? [previousConversation] : [])].map((c) => [c.id, c])
      )
      queryClient.setQueryData(
        conversationKeys.list(workspaceId, streamId, {}),
        (old: ConversationWithStaleness[] | undefined) => old?.map((c) => updatedById.get(c.id) ?? c)
      )
      // Apply the returned aggregates to the board store now, so the board card /
      // panel re-file on the HTTP response instead of waiting for the socket echo
      // (which then lands as an idempotent overwrite). No-op for uncached rows.
      void mergeBoardConversation(conversation.id, conversation)
      if (previousConversation) void mergeBoardConversation(previousConversation.id, previousConversation)
      // The expanded per-conversation message panels refetch their row sets.
      queryClient.invalidateQueries({ queryKey: conversationKeys.messages(conversation.id) })
      if (previousConversation) {
        queryClient.invalidateQueries({ queryKey: conversationKeys.messages(previousConversation.id) })
      }
    },
  })
}

/**
 * The confirm half of the settling pair: "Keep here" settles the row where it
 * already sits. Nothing moves, so only the settling set changes — the returned
 * aggregate and set are written into the list cache, the board store and the
 * by-id post cache so the mark fades on the response rather than the socket
 * echo (which then lands as an idempotent overwrite). Success is silent
 * (INV-63): the mark fading IS the confirmation.
 */
export function useSettleConversationMessage(workspaceId: string, streamId: string) {
  const conversationService = useConversationService()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ messageId, conversationId }: { messageId: string; conversationId: string }) =>
      conversationService.settleMessage(workspaceId, conversationId, messageId),
    onSuccess: ({ conversation, settlingMessageIds }) => {
      queryClient.setQueryData(
        conversationKeys.list(workspaceId, streamId, {}),
        (old: ConversationWithStaleness[] | undefined) => old?.map((c) => (c.id === conversation.id ? conversation : c))
      )
      void mergeBoardConversation(conversation.id, conversation, settlingMessageIds)
      const boardPostKey = conversationKeys.boardPost(conversation.id)
      if (queryClient.getQueryData(boardPostKey)) {
        queryClient.setQueryData<BoardPost>(boardPostKey, (prev) =>
          prev ? { ...prev, conversation, settlingMessageIds } : prev
        )
      }
    },
  })
}

/**
 * Batch counterpart of {@link useReassignConversationMessage}: reassign a set of
 * selected messages to another conversation, or split them into a new one
 * (`targetConversationId` omitted). The response carries the destination and
 * every source that lost messages; they're written straight into the list cache
 * so the overlay recolors immediately — a minted destination is appended if it
 * isn't already present. The `conversation:*` socket events that follow are
 * idempotent overwrites of the same rows.
 */
export function useReassignMessagesToConversation(workspaceId: string, streamId: string) {
  const conversationService = useConversationService()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({
      messageIds,
      targetConversationId,
    }: {
      messageIds: string[]
      targetConversationId?: string | null
    }) => conversationService.reassignMessages(workspaceId, { streamId, messageIds, targetConversationId }),
    onSuccess: ({ conversation, sourceConversations }) => {
      const updatedById = new Map([conversation, ...sourceConversations].map((c) => [c.id, c]))
      queryClient.setQueryData(
        conversationKeys.list(workspaceId, streamId, {}),
        (old: ConversationWithStaleness[] | undefined) => {
          if (!old) return old
          const merged = old.map((c) => updatedById.get(c.id) ?? c)
          // A minted destination isn't in the list yet — append it.
          return old.some((c) => c.id === conversation.id) ? merged : [...merged, conversation]
        }
      )
      for (const id of [conversation.id, ...sourceConversations.map((c) => c.id)]) {
        queryClient.invalidateQueries({ queryKey: conversationKeys.messages(id) })
      }
    },
  })
}

/**
 * Ask the clustering model how a conversation should be split. Read-only — the
 * mutation returns the proposal and writes nothing; the caller renders it for
 * confirmation and applies it via {@link useApplySplit}.
 */
export function useProposeSplit(workspaceId: string) {
  const conversationService = useConversationService()
  return useMutation({
    mutationFn: (conversationId: string) => conversationService.proposeSplit(workspaceId, conversationId),
  })
}

/**
 * Apply a confirmed split proposal. Mirrors {@link useReassignMessagesToConversation}'s
 * cache handling: the re-titled source and every minted conversation are written
 * straight into the list cache (minted ones appended) so the board/overlay recolor
 * immediately; the `conversation:*` socket events that follow are idempotent
 * overwrites of the same rows. Messages for touched conversations are invalidated.
 */
export function useApplySplit(workspaceId: string, streamId: string) {
  const conversationService = useConversationService()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ conversationId, groups }: { conversationId: string; groups: SplitGroupInput[] }) =>
      conversationService.applySplit(workspaceId, conversationId, groups),
    onSuccess: ({ conversation, newConversations }) => {
      const updatedById = new Map([conversation, ...newConversations].map((c) => [c.id, c]))
      queryClient.setQueryData(
        conversationKeys.list(workspaceId, streamId, {}),
        (old: ConversationWithStaleness[] | undefined) => {
          if (!old) return old
          const merged = old.map((c) => updatedById.get(c.id) ?? c)
          // Minted conversations aren't in the list yet — append the new ones.
          const present = new Set(old.map((c) => c.id))
          return [...merged, ...newConversations.filter((c) => !present.has(c.id))]
        }
      )
      for (const id of [conversation.id, ...newConversations.map((c) => c.id)]) {
        queryClient.invalidateQueries({ queryKey: conversationKeys.messages(id) })
      }
    },
  })
}

/**
 * Rename a conversation's topic and/or mark it resolved/reopened from the board
 * card or conversation panel. Optimistic + self-reconciling: the change shows the
 * instant it's dispatched and settles on the HTTP response, no socket wait.
 *
 * Patches WHICHEVER cache holds the row — the board-seeded IDB card
 * (`db.conversations`) AND/OR the by-id `boardPost` query cache a deep-linked
 * panel reads (that panel is deliberately not seeded into IDB, so a rename from
 * it would otherwise show nothing until a `conversation:updated` echo that, for a
 * private/DM/scratchpad conversation, is never broadcast workspace-wide). On
 * success `mergeBoardConversation` runs the same idempotent authoritative write
 * the socket echo would (clearing the optimistic `_status`); on error both caches
 * roll back and a single `toast.error` fires (INV-63 — success is silent).
 */
export function useUpdateConversation(workspaceId: string) {
  const conversationService = useConversationService()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({
      conversationId,
      topicSummary,
      status,
    }: {
      conversationId: string
      topicSummary?: string
      status?: "active" | "resolved"
    }) => conversationService.updateConversation(workspaceId, conversationId, { topicSummary, status }),
    onMutate: async ({ conversationId, topicSummary, status }) => {
      const patch = {
        ...(topicSummary !== undefined ? { topicSummary } : {}),
        ...(status !== undefined ? { status } : {}),
      }
      const prevRow = await db.conversations.get(conversationId)
      if (prevRow) {
        await db.conversations.put({
          ...prevRow,
          conversation: { ...prevRow.conversation, ...patch },
          _status: "pending",
        })
      }
      const boardPostKey = conversationKeys.boardPost(conversationId)
      const prevQuery = queryClient.getQueryData<BoardPost>(boardPostKey)
      if (prevQuery) {
        queryClient.setQueryData<BoardPost>(boardPostKey, {
          ...prevQuery,
          conversation: { ...prevQuery.conversation, ...patch },
        })
      }
      return { prevRow, prevQuery, conversationId }
    },
    onError: (_error, _vars, ctx) => {
      if (ctx?.prevRow) void db.conversations.put(ctx.prevRow)
      if (ctx?.prevQuery) queryClient.setQueryData(conversationKeys.boardPost(ctx.conversationId), ctx.prevQuery)
      toast.error("Couldn't update the conversation")
    },
    onSuccess: ({ conversation }, { conversationId }) => {
      void mergeBoardConversation(conversationId, conversation)
      const boardPostKey = conversationKeys.boardPost(conversationId)
      if (queryClient.getQueryData(boardPostKey)) {
        queryClient.setQueryData<BoardPost>(boardPostKey, (prev) => (prev ? { ...prev, conversation } : prev))
      }
    },
  })
}

/**
 * Bootstrap the viewer's board exclusions (hidden cards + muted streams) into IDB
 * (subscribe-then-fetch, INV-53; `refetchOnReconnect` closes the gap after a drop).
 * The reactive store then drives the board filter live; socket `board:*` events
 * (workspace-sync) patch IDB between fetches.
 */
export function useBoardExclusions(workspaceId: string) {
  const conversationService = useConversationService()
  const query = useQuery({
    queryKey: [...conversationKeys.all, "exclusions", workspaceId] as const,
    queryFn: () => conversationService.getBoardExclusions(workspaceId),
    refetchOnReconnect: true,
    staleTime: 60_000,
  })
  useEffect(() => {
    if (query.data) void seedBoardExclusions(workspaceId, query.data)
  }, [query.data, workspaceId])
  return query
}

/**
 * Hide a conversation card from the board (snooze until it revives). Optimistic:
 * the exclusion store write drops the card immediately; the server `hiddenAt`
 * reconciles the watermark on success. No success toast — the card vanishing is
 * the signal (INV-63); errors roll back and `toast.error`.
 */
export function useHideConversation(workspaceId: string) {
  const conversationService = useConversationService()
  return useMutation({
    mutationFn: (conversationId: string) => conversationService.hideConversation(workspaceId, conversationId),
    onMutate: async (conversationId: string) => {
      const prev = await db.boardHiddenConversations.get(conversationId)
      await putHidden(workspaceId, conversationId, Date.now())
      return { conversationId, prev }
    },
    onError: (_error, conversationId, ctx) => {
      if (ctx?.prev) void putHidden(workspaceId, conversationId, ctx.prev.hiddenAt)
      else void deleteHidden(conversationId)
      toast.error("Couldn't hide from the board")
    },
    onSuccess: ({ hiddenAt }, conversationId) => {
      void putHidden(workspaceId, conversationId, Date.parse(hiddenAt))
    },
  })
}

export function useUnhideConversation(workspaceId: string) {
  const conversationService = useConversationService()
  return useMutation({
    mutationFn: (conversationId: string) => conversationService.unhideConversation(workspaceId, conversationId),
    onMutate: async (conversationId: string) => {
      const prev = await db.boardHiddenConversations.get(conversationId)
      await deleteHidden(conversationId)
      return { conversationId, prev }
    },
    onError: (_error, conversationId, ctx) => {
      if (ctx?.prev) void putHidden(workspaceId, conversationId, ctx.prev.hiddenAt)
      toast.error("Couldn't unhide")
    },
  })
}

export function useMuteStream(workspaceId: string) {
  const conversationService = useConversationService()
  return useMutation({
    mutationFn: (streamId: string) => conversationService.muteStream(workspaceId, streamId),
    onMutate: (streamId: string) => {
      void putMuted(workspaceId, streamId)
      return { streamId }
    },
    onError: (_error, streamId) => {
      void deleteMuted(streamId)
      toast.error("Couldn't mute the stream")
    },
  })
}

export function useUnmuteStream(workspaceId: string) {
  const conversationService = useConversationService()
  return useMutation({
    mutationFn: (streamId: string) => conversationService.unmuteStream(workspaceId, streamId),
    onMutate: (streamId: string) => {
      void deleteMuted(streamId)
      return { streamId }
    },
    onError: (_error, streamId) => {
      void putMuted(workspaceId, streamId)
      toast.error("Couldn't unmute the stream")
    },
  })
}

/**
 * Split a soft thread out of its parent conversation into its own topic (the
 * board seam gesture). The card visibly re-forms into a nested branch group, so
 * no success toast (INV-63); the board feed is invalidated so the new
 * conversation and the shrunken source re-project, and the
 * `conversation:created`/`updated` sync events converge the card in place. A
 * failure surfaces as an error toast — the gesture has no other on-screen signal.
 */
export function useSplitThread(workspaceId: string) {
  const conversationService = useConversationService()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ conversationId, threadStreamId }: { conversationId: string; threadStreamId: string }) =>
      conversationService.splitThread(workspaceId, conversationId, threadStreamId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...conversationKeys.all, "workspaceList", workspaceId] })
    },
    onError: () => {
      toast.error("Couldn't split the thread. Try again.")
    },
  })
}
