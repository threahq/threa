import { useCallback } from "react"
import { useNavigate } from "react-router-dom"
import { draftStreamScope, type JSONContent } from "@threa/types"
import type { DraftAttachment } from "@/db"
import { queueContentHandoff } from "@/stores/composer-handoff-store"
import { setComposerTarget } from "./use-composer-target"
import { parseBoardDraftKey } from "@/lib/board/draft-keys"

/** The host stream's timeline is mounted on this page (`StreamContent` stamps its scroller). */
function hostComposerMounted(hostStreamId: string): boolean {
  return document.querySelector(`[data-stream-scroller="${hostStreamId}"]`) !== null
}

/**
 * Send an aside draft to the composer it was opened from. The blocks ride the
 * same hand-off queue a share does, so the destination's own draft is stashed
 * rather than replaced (INV-43); a conversation origin additionally points the
 * host composer at that conversation's reply scope first, so the send files
 * where the user was writing instead of top level.
 *
 * The queue drains through the host stream's mounted `MessageInput`. A surface
 * without one (the board, a conversation panel on its own) would leave the
 * hand-off parked invisibly, so the send takes the user to the host stream —
 * where the composer is — and the queued blocks land as the page mounts.
 */
export function useAsideHandoff(workspaceId: string) {
  const navigate = useNavigate()
  return useCallback(
    async (params: {
      hostStreamId: string
      originScope: string
      content: JSONContent[]
      attachments?: DraftAttachment[]
    }): Promise<boolean> => {
      if (params.content.length === 0 && (params.attachments?.length ?? 0) === 0) return false
      const hostScope = draftStreamScope(params.hostStreamId)
      if (params.originScope !== hostScope) {
        // Only scopes the timeline composer can hold: today the conversation
        // reply scopes it already adopts. Anything else would arm a host that
        // cannot send it, stranding the draft (INV-11) — refuse instead.
        const board = parseBoardDraftKey(params.originScope)
        if (board?.kind !== "reply") return false
        await setComposerTarget(workspaceId, hostScope, params.originScope)
      }
      queueContentHandoff(params.hostStreamId, params.content, params.attachments ?? [])
      if (!hostComposerMounted(params.hostStreamId)) {
        navigate(`/w/${workspaceId}/s/${params.hostStreamId}`)
      }
      return true
    },
    [workspaceId, navigate]
  )
}
