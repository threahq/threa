import { useMemo } from "react"
import { useDraftsFromStore } from "@/stores/draft-store"
import { draftInlineText } from "@/lib/drafts/decryption"
import { isEmptyContent } from "@/lib/prosemirror-utils"
import { parseAsideDraftScope } from "@/lib/drafts/aside-scope"

export interface AsideDraftRow {
  id: string
  scope: string
  /** One-line body preview, "" while the draft is still empty. */
  preview: string
  clientUpdatedAt: number
  isEmpty: boolean
}

/**
 * The drafts living in one aside, most recently touched first. Read straight
 * off the draft store by scope: an aside's drafts are in no pile (INV-62's
 * privacy twin for drafts, see `lib/drafts/aside-scope.ts`), so this is the
 * only surface that lists them.
 */
export function useAsideDrafts(workspaceId: string, asideId: string): AsideDraftRow[] {
  const drafts = useDraftsFromStore(workspaceId)
  return useMemo(
    () =>
      drafts
        .filter((draft) => parseAsideDraftScope(draft.scope)?.asideId === asideId)
        .map((draft) => ({
          id: draft.id,
          scope: draft.scope,
          preview: draftInlineText(draft.contentJson),
          clientUpdatedAt: draft.clientUpdatedAt,
          isEmpty: isEmptyContent(draft.contentJson),
        }))
        .sort((a, b) => b.clientUpdatedAt - a.clientUpdatedAt),
    [drafts, asideId]
  )
}
