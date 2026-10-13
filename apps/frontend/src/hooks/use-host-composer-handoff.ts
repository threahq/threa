import { useCallback } from "react"
import { useNavigate } from "react-router-dom"
import { draftStreamScope, type JSONContent } from "@threahq/types"
import type { DraftAttachment } from "@/db"
import { hasShareHandoffTaker, queueContentHandoff } from "@/stores/composer-handoff-store"
import { setComposerTarget } from "./use-composer-target"
import { parseBoardDraftKey } from "@/lib/board/draft-keys"

/** The host stream's timeline is mounted on this page (`StreamContent` stamps its scroller). */
function hostComposerMounted(hostStreamId: string): boolean {
  return document.querySelector(`[data-stream-scroller="${hostStreamId}"]`) !== null
}

/**
 * Send content to the composer it was written beside. The blocks ride the same
 * hand-off queue a share does, so the destination's own draft is stashed rather
 * than replaced (INV-43).
 *
 * A conversation origin goes to that conversation's own reply composer when one
 * is on the page (a board card's, a conversation pane's). Otherwise, and for a
 * stream origin, the host stream's composer takes it, pointed at the
 * conversation's reply scope first so the send files where the user was writing
 * instead of top level. A page without the host stream's timeline would leave
 * that hand-off parked invisibly, so the send takes the user to the host
 * stream, where the queued blocks land as the page mounts.
 *
 * Returns null when refused, else whether it left the page, and the
 * destination's eventual verdict: true once it has persisted the blocks and
 * files, false if it could not (or the hand-off expired) — the caller decides
 * what to let go of on that.
 */
export function useHostComposerHandoff(workspaceId: string) {
  const navigate = useNavigate()
  return useCallback(
    async (params: {
      hostStreamId: string
      originScope: string
      content: JSONContent[]
      attachments?: DraftAttachment[]
    }): Promise<{ delivered: Promise<boolean>; navigated: boolean } | null> => {
      const attachments = params.attachments ?? []
      if (params.content.length === 0 && attachments.length === 0) return null
      const hostScope = draftStreamScope(params.hostStreamId)
      if (params.originScope !== hostScope) {
        // Only conversation reply scopes: their own composer takes them, and
        // the timeline composer adopts them. Anything else would arm a host
        // that cannot send it, stranding the draft (INV-11) — refuse instead.
        const board = parseBoardDraftKey(params.originScope)
        if (board?.kind !== "reply") return null
        if (hasShareHandoffTaker(workspaceId, params.originScope)) {
          const queued = queueContentHandoff(workspaceId, params.originScope, params.content, attachments)
          return { ...queued, navigated: false }
        }
        await setComposerTarget(workspaceId, hostScope, params.originScope)
      }
      const queued = queueContentHandoff(workspaceId, params.hostStreamId, params.content, attachments)
      const navigated = !hostComposerMounted(params.hostStreamId)
      if (navigated) navigate(`/w/${workspaceId}/s/${params.hostStreamId}`)
      return { ...queued, navigated }
    },
    [workspaceId, navigate]
  )
}
