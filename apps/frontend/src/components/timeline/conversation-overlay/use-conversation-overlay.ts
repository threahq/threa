import { useCallback, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { useConversations, useReassignConversationMessage } from "@/hooks/use-conversations"
import { buildConversationOverlayModel, type ConversationOverlayContext } from "./model"

/**
 * Owns the conversation overlay's data and interaction state for one stream:
 * fetches the conversation list (live via the socket handlers inside
 * `useConversations`), derives the color/membership model, and exposes the
 * focus + correction handlers the timeline rows consume.
 *
 * Returns undefined while disabled so the timeline render context carries no
 * overlay and rows render exactly as before.
 */
export function useConversationOverlay({
  workspaceId,
  streamId,
  enabled,
}: {
  workspaceId: string
  streamId: string
  enabled: boolean
}): ConversationOverlayContext | undefined {
  const { conversations } = useConversations(workspaceId, streamId, { enabled })
  const [focusedConversationId, setFocusedConversationId] = useState<string | null>(null)
  const reassign = useReassignConversationMessage(workspaceId, streamId)

  // Focus is ephemeral view state: drop it when the overlay closes or the
  // user navigates to another stream.
  useEffect(() => {
    setFocusedConversationId(null)
  }, [enabled, streamId])

  const model = useMemo(() => buildConversationOverlayModel(conversations, streamId), [conversations, streamId])

  const onToggleFocus = useCallback((conversationId: string) => {
    setFocusedConversationId((previous) => (previous === conversationId ? null : conversationId))
  }, [])

  const { mutate } = reassign
  const onReassignMessage = useCallback(
    (messageId: string, toConversationId: string) => {
      mutate(
        { messageId, toConversationId },
        {
          onError: () => toast.error("Couldn't move the message to that conversation"),
        }
      )
    },
    [mutate]
  )

  const pendingMessageId = reassign.isPending ? (reassign.variables?.messageId ?? null) : null

  return useMemo(
    () => (enabled ? { model, focusedConversationId, onToggleFocus, onReassignMessage, pendingMessageId } : undefined),
    [enabled, model, focusedConversationId, onToggleFocus, onReassignMessage, pendingMessageId]
  )
}
