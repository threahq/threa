import { useCallback, useMemo } from "react"
import { type CachedDraft } from "@/db"
import { hasSeededDraftCache, useComposerLoadedFromStore, useDraftsFromStore } from "@/stores/draft-store"
import { deleteDraftById } from "@/sync/draft-sync"
import { useOptionalSyncEngine } from "@/sync/sync-engine"

// Re-exported so components (which cannot import from `@/db` per INV-15) can
// still get the row type they render without reaching into the data layer.
// A "stashed" draft is just a `CachedDraft` that isn't the loaded one for its
// scope — there is no separate stash entity, plaintext or sealed.
export type { CachedDraft }

export interface UseStashedDraftsResult {
  /** Stashed drafts for the current scope (every draft except the loaded one), newest first. */
  drafts: CachedDraft[]
  /** True once the draft cache has been seeded (used to suppress empty-flash in the picker). */
  isLoaded: boolean
  /** Delete a stashed row (and mirror the removal to the backend). */
  deleteStashedDraft: (id: string) => Promise<void>
}

/**
 * The stashed drafts for a specific scope (a stream or a thread's parent
 * message) — every draft for the scope except the one loaded into the composer.
 * Pass `undefined` for `scope` while the host is still resolving what to target;
 * the hook returns an empty list and silently no-ops.
 *
 * Stash and restore are pointer moves (see `useStashComposer`): the loaded draft
 * is simply detached/attached via the `composerLoaded` pointer, so a sealed E2E
 * draft rides the same path with no plaintext snapshot (E2EE-4). This hook owns
 * only the read (`drafts`) and delete; deletion routes through the same
 * `deleteDraftById` the Drafts explorer uses so the two surfaces can't drift.
 */
export function useStashedDrafts(workspaceId: string, scope: string | undefined): UseStashedDraftsResult {
  const allDrafts = useDraftsFromStore(workspaceId)
  const loaded = useComposerLoadedFromStore(workspaceId)
  const loadedId = scope ? (loaded.find((row) => row.scope === scope)?.draftId ?? null) : null

  const drafts = useMemo(() => {
    if (!workspaceId || !scope) return []
    return allDrafts
      .filter((draft) => draft.scope === scope && draft.id !== loadedId)
      .sort((a, b) => b.clientUpdatedAt - a.clientUpdatedAt)
  }, [allDrafts, workspaceId, scope, loadedId])

  const isLoaded = hasSeededDraftCache(workspaceId)
  const syncEngine = useOptionalSyncEngine()

  const deleteStashedDraft = useCallback(
    async (id: string) => {
      await deleteDraftById(workspaceId, id)
      syncEngine?.kickOperationQueue()
    },
    [workspaceId, syncEngine]
  )

  return { drafts, isLoaded, deleteStashedDraft }
}
