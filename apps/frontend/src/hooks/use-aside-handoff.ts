import { useCallback } from "react"
import { draftStreamScope, type JSONContent } from "@threa/types"
import { queueContentHandoff } from "@/stores/composer-handoff-store"
import { setComposerTarget } from "./use-composer-target"
import { parseBoardDraftKey } from "@/lib/board/draft-keys"

/**
 * Send an aside draft to the composer it was opened from. The blocks ride the
 * same hand-off queue a share does, so the destination's own draft is stashed
 * rather than replaced (INV-43); a conversation origin additionally points the
 * host composer at that conversation's reply scope first, so the send files
 * where the user was writing instead of top level.
 */
export function useAsideHandoff(workspaceId: string) {
  return useCallback(
    async (params: { hostStreamId: string; originScope: string; content: JSONContent[] }): Promise<boolean> => {
      if (params.content.length === 0) return false
      const hostScope = draftStreamScope(params.hostStreamId)
      if (params.originScope !== hostScope) {
        // Only scopes the timeline composer can hold: today the conversation
        // reply scopes it already adopts. Anything else would arm a host that
        // cannot send it, stranding the draft (INV-11) — refuse instead.
        const board = parseBoardDraftKey(params.originScope)
        if (board?.kind !== "reply") return false
        await setComposerTarget(workspaceId, hostScope, params.originScope)
      }
      queueContentHandoff(params.hostStreamId, params.content)
      return true
    },
    [workspaceId]
  )
}
