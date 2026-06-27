import { useEffect } from "react"
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  useConversationService,
  useMessageService,
  useStreamService,
  useSocket,
  useSocketReconnectCount,
} from "@/contexts"
import { useOptionalSyncEngine } from "@/sync/sync-engine"
import { seedBoardPosts, optimisticBoardReply } from "@/stores/board-store"
import { useDraftScratchpads } from "./use-draft-scratchpads"
import { useQueueDraftMessage } from "./use-queue-draft-message"
import { generateClientId } from "./use-stream-or-draft"
import { StreamTypes } from "@threa/types"
import type { CompanionMode, ConversationWithStaleness, ConversationStatus, JSONContent, Message } from "@threa/types"

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
}

export const conversationKeys = {
  all: ["conversations"] as const,
  list: (workspaceId: string, streamId: string, options?: { status?: string; limit?: number }) =>
    [...conversationKeys.all, "list", workspaceId, streamId, options ?? {}] as const,
  workspaceList: (workspaceId: string, options?: { status?: string; limit?: number }) =>
    [...conversationKeys.all, "workspaceList", workspaceId, options ?? {}] as const,
  byId: (workspaceId: string, conversationId: string) =>
    [...conversationKeys.all, "detail", workspaceId, conversationId] as const,
  messages: (conversationId: string) => ["conversations", conversationId, "messages"] as const,
  boardMessages: (conversationId: string) => ["conversations", conversationId, "board-messages"] as const,
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
  options?: { status?: ConversationStatus; limit?: number }
) {
  const conversationService = useConversationService()
  const { status, limit } = options ?? {}

  const query = useInfiniteQuery({
    queryKey: conversationKeys.workspaceList(workspaceId, { status, limit }),
    queryFn: ({ pageParam }) => conversationService.listByWorkspace(workspaceId, { status, limit, cursor: pageParam }),
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
  const { queueDraftMessage } = useQueueDraftMessage(workspaceId)
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ target, contentJson, attachmentIds }: CreateBoardPostInput) => {
      if (target.type === "newScratchpad") {
        const draftId = await createScratchpad(target.companionMode)
        await queueDraftMessage(
          { contentJson, attachmentIds },
          {
            workspaceId,
            streamId: draftId,
            streamCreation: { type: StreamTypes.SCRATCHPAD, companionMode: target.companionMode },
            draftId,
          }
        )
        return
      }

      await messageService.create(workspaceId, target.streamId, {
        streamId: target.streamId,
        contentJson,
        attachmentIds,
        clientMessageId: generateClientId(),
        conversation: { intent: "new" },
      })
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
  contentJson: JSONContent
  attachmentIds?: string[]
}

/**
 * Where a board reply lands. A conversation owns exactly one stream — its
 * messages are wholly flat or wholly inside a thread; a thread is always its own
 * conversation — so "follow where the conversation lives" reduces to the host
 * stream type plus whether the conversation is still a lone root (user ruling):
 *
 *  - **thread conversation** → into the thread (it IS the thread).
 *  - **flat conversation with replies** (channel/DM) → flat in its stream.
 *  - **scratchpad** → always flat (scratchpads don't thread).
 *  - **a lone root message** in a channel/DM → start a thread off it: a single
 *    message has no established shape, and threading a bare message keeps the
 *    channel from sprouting a stray top-level reply. Scratchpads stay flat even
 *    when lone; a deleted root (no opening id) can't be threaded, so it stays flat.
 *
 * "Into the thread" and "flat" are the same send — into the conversation's own
 * stream, attached via the `existing` directive — so only the lone channel/DM
 * root diverges into a new thread.
 */
export type BoardReplyPlan = { kind: "newThread"; parentMessageId: string } | { kind: "intoConversation" }

export function planBoardReply(input: {
  hostStreamType: string | undefined
  messageCount: number
  openingMessageId: string | null
}): BoardReplyPlan {
  const threadable = input.hostStreamType === StreamTypes.CHANNEL || input.hostStreamType === StreamTypes.DM
  if (threadable && input.messageCount <= 1 && input.openingMessageId) {
    return { kind: "newThread", parentMessageId: input.openingMessageId }
  }
  return { kind: "intoConversation" }
}

/**
 * Reply to a board post from the feed, routed by {@link planBoardReply}. Returns
 * the created message AND the resolved plan so the caller knows where it landed:
 * a `newThread` reply lives in a brand-new thread stream (its own conversation),
 * NOT this card's conversation, so the card must not show it in place — only an
 * `intoConversation` reply belongs under the card that produced it. Board-wide
 * liveness/optimism across cards is a follow-up (no cache writes here).
 */
export function useReplyToBoardPost(workspaceId: string) {
  const messageService = useMessageService()
  const streamService = useStreamService()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      conversation,
      openingMessageId,
      hostStreamType,
      messageCount,
      contentJson,
      attachmentIds,
    }: ReplyToBoardPostInput): Promise<{ message: Message; plan: BoardReplyPlan }> => {
      const base = {
        contentJson,
        attachmentIds: attachmentIds && attachmentIds.length > 0 ? attachmentIds : undefined,
        clientMessageId: generateClientId(),
      }

      const plan = planBoardReply({ hostStreamType, messageCount, openingMessageId })

      if (plan.kind === "newThread") {
        // Create-or-find is idempotent server-side on (parentStreamId,
        // parentMessageId), so this can't double-create the thread.
        const thread = await streamService.create(workspaceId, {
          type: StreamTypes.THREAD,
          parentStreamId: conversation.streamId,
          parentMessageId: plan.parentMessageId,
        })
        const message = await messageService.create(workspaceId, thread.id, { streamId: thread.id, ...base })
        return { message, plan }
      }

      const message = await messageService.create(workspaceId, conversation.streamId, {
        streamId: conversation.streamId,
        ...base,
        conversation: { intent: "existing", conversationId: conversation.id },
      })
      // Optimistically reflect the reply on the board's IDB feed: the card jumps
      // to the top and shows the reply before the round-trip's `conversation:updated`
      // echo merges over it (clearing pending). The echo carries only the
      // aggregate, so this preview is the lasting one until the next seed —
      // correct for a text reply, but it can't show attachments/previews.
      void optimisticBoardReply(
        conversation.id,
        {
          id: message.id,
          authorId: message.authorId,
          authorType: message.authorType,
          contentMarkdown: message.contentMarkdown,
          reactions: message.reactions,
          attachments: [],
          linkPreviews: [],
          createdAt: message.createdAt,
        },
        Date.parse(message.createdAt) || Date.now()
      )
      // A reply with attachments can't be previewed fully from the optimistic
      // row (the message wire shape carries no attachment summaries), so refetch
      // the board head to backfill them; the text/bump still showed instantly.
      if (base.attachmentIds) {
        void queryClient.invalidateQueries({
          queryKey: [...conversationKeys.all, "workspaceList", workspaceId],
          refetchType: "active",
        })
      }
      return { message, plan }
    },
  })
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
    data: conversations = [],
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
      // The expanded per-conversation message panels refetch their row sets.
      queryClient.invalidateQueries({ queryKey: conversationKeys.messages(conversation.id) })
      if (previousConversation) {
        queryClient.invalidateQueries({ queryKey: conversationKeys.messages(previousConversation.id) })
      }
    },
  })
}
