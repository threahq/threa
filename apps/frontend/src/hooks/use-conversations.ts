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
 * Read-only bootstrap (the activity-feed pattern): `staleTime: Infinity` +
 * `refetchOnMount` so the list is fresh on open. Unlike the activity feed (which
 * gets live updates via workspace-room socket handlers) the board has no socket
 * subscription yet — conversation events are delivered only to per-stream rooms
 * today (see board-view design doc) — so `refetchOnReconnect` is left ON: a
 * reconnect is the board's only refresh path until cross-stream events land.
 */
export function useWorkspaceConversations(
  workspaceId: string,
  options?: { status?: ConversationStatus; limit?: number }
) {
  const conversationService = useConversationService()
  const { status, limit } = options ?? {}

  return useInfiniteQuery({
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
  /** The post's opening message id — the thread parent for a channel reply. */
  openingMessageId: string | null
  /** Host stream type (`channel` | `dm` | `scratchpad` | `thread` | undefined). */
  hostStreamType: string | undefined
  contentJson: JSONContent
  attachmentIds?: string[]
}

/**
 * Reply to a board post from the feed. Where the reply lands depends on the
 * conversation's host stream (user ruling):
 *
 *  - **channel** → a thread reply off the post's opening message, so it stays
 *    scoped to the topic instead of interleaving into the channel's live
 *    timeline. Thread creation is idempotent server-side on
 *    `(parentStreamId, parentMessageId)`, so we create-or-find the thread, then
 *    send into it — its own conversation forms there.
 *  - **dm / scratchpad / thread card** → a message into the conversation's stream
 *    attached to it via the `existing` directive ("the conversation as a whole"),
 *    so the assignment + activity bump happen synchronously in the send txn.
 *
 * A channel post whose opening message was deleted falls through to the second
 * path (a top-level message attached to the conversation) — there's no anchor to
 * thread off.
 *
 * Returns the created message so the card can show it in place; board-wide
 * liveness/optimism across cards is a follow-up (no cache writes here).
 */
export function useReplyToBoardPost(workspaceId: string) {
  const messageService = useMessageService()
  const streamService = useStreamService()

  return useMutation({
    mutationFn: async ({
      conversation,
      openingMessageId,
      hostStreamType,
      contentJson,
      attachmentIds,
    }: ReplyToBoardPostInput): Promise<Message> => {
      const base = {
        contentJson,
        attachmentIds: attachmentIds && attachmentIds.length > 0 ? attachmentIds : undefined,
        clientMessageId: generateClientId(),
      }

      if (hostStreamType === StreamTypes.CHANNEL && openingMessageId) {
        const thread = await streamService.create(workspaceId, {
          type: StreamTypes.THREAD,
          parentStreamId: conversation.streamId,
          parentMessageId: openingMessageId,
        })
        return messageService.create(workspaceId, thread.id, { streamId: thread.id, ...base })
      }

      return messageService.create(workspaceId, conversation.streamId, {
        streamId: conversation.streamId,
        ...base,
        conversation: { intent: "existing", conversationId: conversation.id },
      })
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
