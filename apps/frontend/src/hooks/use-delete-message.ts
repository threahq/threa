import { useState, useCallback } from "react"
import { toast } from "sonner"
import { useMessageService } from "@/contexts"
import { enqueueOperation } from "@/sync/operation-queue"

/**
 * Delete a confirmed message, falling back to the offline operation queue when
 * the request fails. Shared by the stream timeline (`MessageEvent`) and the
 * out-of-stream row (`MessageItem`) so both delete surfaces stay one path
 * (INV-35). Owns its own `isDeleting`; the caller owns any confirm-dialog state
 * and closes it after `deleteMessage` settles (this never throws).
 */
export function useDeleteMessage(workspaceId: string): {
  deleteMessage: (messageId: string) => Promise<void>
  isDeleting: boolean
} {
  const messageService = useMessageService()
  const [isDeleting, setIsDeleting] = useState(false)
  const deleteMessage = useCallback(
    async (messageId: string) => {
      setIsDeleting(true)
      try {
        await messageService.delete(workspaceId, messageId)
      } catch {
        await enqueueOperation(workspaceId, "delete_message", { messageId })
        toast.info("Delete queued — will complete when back online")
      } finally {
        setIsDeleting(false)
      }
    },
    [messageService, workspaceId]
  )
  return { deleteMessage, isDeleting }
}
