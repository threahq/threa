import { useMemo } from "react"
import { useWorkspaceStreams } from "@/stores/workspace-store"
import { resolveDraftLandingSite, type DraftLandingSite } from "@/lib/drafts/landing-site"
import { draftScopesSignature, useBoardDraftContext } from "./use-board-draft-context"

/**
 * Landing site per draft scope — where sending that draft would put the message
 * and whether it lands flat. Reads the conversations the scopes reference through
 * the shared {@link useBoardDraftContext}, which is gated on an id signature, so
 * mounting this in an always-present composer costs nothing per keystroke.
 */
export function useDraftLandingSites(workspaceId: string, scopes: readonly string[]): Map<string, DraftLandingSite> {
  const scopesSignature = useMemo(() => draftScopesSignature(scopes), [scopes])
  const cachedStreams = useWorkspaceStreams(workspaceId)
  const { boardPostMap } = useBoardDraftContext(workspaceId, scopesSignature)

  const streamTypeById = useMemo(() => {
    const map = new Map<string, string | undefined>()
    for (const stream of cachedStreams ?? []) map.set(stream.id, stream.type)
    return map
  }, [cachedStreams])

  return useMemo(() => {
    const context = { streamTypeById, boardPostByConversationId: boardPostMap }
    const sites = new Map<string, DraftLandingSite>()
    for (const scope of scopesSignature.split("|")) {
      if (!scope) continue
      sites.set(scope, resolveDraftLandingSite(scope, context))
    }
    return sites
  }, [scopesSignature, streamTypeById, boardPostMap])
}
