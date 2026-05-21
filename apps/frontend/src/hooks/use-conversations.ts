import { useEffect } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useConversationService, useSocket, useSocketReconnectCount } from "@/contexts"
import type { ConversationWithStaleness, ConversationStatus } from "@threa/types"

export const conversationKeys = {
  all: ["conversations"] as const,
  list: (workspaceId: string, streamId: string, options?: { status?: string; limit?: number }) =>
    [...conversationKeys.all, "list", workspaceId, streamId, options ?? {}] as const,
  byId: (workspaceId: string, conversationId: string) =>
    [...conversationKeys.all, "detail", workspaceId, conversationId] as const,
  messages: (conversationId: string) => ["conversations", conversationId, "messages"] as const,
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

export function useConversations(workspaceId: string, streamId: string, options?: UseConversationsOptions) {
  const { status, limit, enabled = true } = options ?? {}
  const conversationService = useConversationService()
  const queryClient = useQueryClient()
  const socket = useSocket()
  const reconnectCount = useSocketReconnectCount()

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
  useEffect(() => {
    if (reconnectCount === 0 || !workspaceId || !streamId || !enabled) return
    queryClient.invalidateQueries({ queryKey: conversationKeys.list(workspaceId, streamId, { status, limit }) })
  }, [reconnectCount, workspaceId, streamId, status, limit, enabled, queryClient])

  // Handle real-time conversation events
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

    socket.on("conversation:created", handleCreated)
    socket.on("conversation:updated", handleUpdated)
    socket.on("conversation:message_assigned", handleMessageAssigned)
    socket.on("conversation:message_reassigned", handleMessageReassigned)

    return () => {
      socket.off("conversation:created", handleCreated)
      socket.off("conversation:updated", handleUpdated)
      socket.off("conversation:message_assigned", handleMessageAssigned)
      socket.off("conversation:message_reassigned", handleMessageReassigned)
    }
  }, [socket, workspaceId, streamId, status, limit, enabled, queryClient])

  return {
    conversations,
    isLoading,
    error,
    refetch,
  }
}
