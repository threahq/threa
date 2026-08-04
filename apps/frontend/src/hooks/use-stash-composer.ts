import { useCallback, useEffect, useRef } from "react"
import { useSearchParams } from "react-router-dom"
import { useLiveQuery } from "dexie-react-hooks"
import { db } from "@/db"
import { useComposerLoadedFromStore } from "@/stores/draft-store"
import { isEmptyContent } from "@/lib/prosemirror-utils"
import { restoreStashedDraftToComposer, stashLoadedDraft } from "./use-draft-message"
import { useStashedDrafts, type CachedDraft, type StashedDraftOrigin } from "./use-stashed-drafts"
import type { DraftComposerState } from "./use-draft-composer"

export interface UseStashComposerResult {
  /** The landing-site-wide pile, newest first. Not rendered yet — restore can't leave a scope safely until chunk 4. */
  drafts: CachedDraft[]
  /** What the picker renders and what `handleRestoreStashed` accepts: this scope's own rows. */
  claimableDrafts: CachedDraft[]
  /** Where each pile row came from, keyed by draft id (structured; the caller formats). */
  originByDraftId: Map<string, StashedDraftOrigin>
  /** Tell the pile whether the picker is open, so membership latches while it is. */
  setPileOpen: (open: boolean) => void
  /** Snapshot the current composer content into the stash, clear the editor. Empty composer → silent no-op. */
  handleStashDraft: () => Promise<void>
  /** Swap: stash current content first (if any), then load the chosen stashed row into the composer. */
  handleRestoreStashed: (id: string) => Promise<void>
  /** Delete a stashed row without restoring. */
  handleDeleteStashed: (id: string) => Promise<void>
}

/**
 * Binds the stashed-drafts pile (`useStashedDrafts`) to a `DraftComposerState`
 * so the two composer hosts (`MessageInput` and `StreamPanel`) don't each carry
 * their own copy of the stash / restore / delete callbacks. It also owns the
 * `?stash=<id>` URL auto-restore.
 *
 * Stash and restore are **pointer moves**, not content snapshots — exactly "a
 * stashed draft is a draft without the active state". Stashing flushes the live
 * editor into its row (sealed for E2E) and detaches the loaded pointer so the row
 * becomes a stash entry; restoring points the scope at the chosen row and lets
 * the composer re-read (decrypting on the way in for E2E) the newly-loaded body.
 * Because nothing is copied, an encrypted draft rides the identical path with no
 * plaintext ever leaving memory (E2EE-4) — so the pile works the same for
 * plaintext and E2E streams with no special-casing here.
 */
/**
 * The draft row named by the URL's `?stash=` param, for surfaces that must
 * decide whether a deep-linked restore is theirs to host (e.g. a board card /
 * conversation panel auto-opening a branch-tail composer). A Dexie point query
 * on the one id — it re-fires only when that row changes, so it's cheap enough
 * to mount per board card. Returns null when there is no param, the row hasn't
 * synced yet, or it belongs to another workspace.
 */
export function useStashParamDraftRow(
  workspaceId: string
): { draftId: string; scope: string; isLoadedForScope: boolean } | null {
  const [searchParams] = useSearchParams()
  const draftId = searchParams.get("stash")
  const row = useLiveQuery(() => (draftId ? db.drafts.get(draftId) : undefined), [draftId])
  const loaded = useComposerLoadedFromStore(workspaceId)
  if (!draftId || !row || row.workspaceId !== workspaceId) return null
  // Already checked out into its own scope's composer: a deep link to it has
  // nothing to restore, so a consumer must not treat it as a pending one.
  const isLoadedForScope = loaded.some((entry) => entry.scope === row.scope && entry.draftId === draftId)
  return { draftId, scope: row.scope, isLoadedForScope }
}

export function useStashComposer(
  composer: DraftComposerState,
  workspaceId: string,
  scope: string | undefined
): UseStashComposerResult {
  const stashedDrafts = useStashedDrafts(workspaceId, scope)

  const handleStashDraft = useCallback(async () => {
    if (!scope) return
    // Nothing worth stashing → silent no-op (parity with the picker's disabled
    // button and the product brief). Attachments alone count as content.
    const hasContent = !isEmptyContent(composer.content)
    const hasAttachments = composer.uploadedIds.length > 0
    if (!hasContent && !hasAttachments) return

    // Flush the live editor into its row first (sealed for E2E, E2EE-4) so the
    // stash entry carries exactly what the user was typing, then detach it. The
    // flush never deletes (it no-ops on empty), so it can't destroy the draft.
    await composer.flushDraft()
    const stashedId = await stashLoadedDraft(workspaceId, scope)
    if (!stashedId) return
    // Re-init the (now draft-less) composer so the editor blanks out.
    composer.markNeedsRehydrate()
  }, [composer, workspaceId, scope])

  const handleRestoreStashed = useCallback(
    async (id: string) => {
      if (!scope) return
      // Restore is a pointer move within the row's own scope: hydration is
      // pointer-based, so a foreign row would render here and the next debounced
      // save would rewrite its `scope` to this host's — a silent migration pushed
      // through a coalescing enqueue that can lose the move server-side. Adopting
      // or moving a foreign row is chunk 4's job; until then a non-claimable id
      // does not restore.
      if (!stashedDrafts.claimableDrafts.some((draft) => draft.id === id)) return
      // Swap semantics: flush whatever the composer holds into its row first so
      // switching drafts never silently destroys work — it stays as a stash entry
      // once the pointer moves off it. `flushDraft` only persists a non-empty
      // editor, so a restore fired while the composer is still mid-hydration
      // (transiently empty) can NEVER delete the currently-loaded draft. A thrown
      // flush (e.g. IDB quota, or a seal that raced a lock) is swallowed: losing a
      // recent auto-save is a smaller harm than aborting the deliberate restore.
      try {
        await composer.flushDraft()
      } catch (err) {
        console.error("Failed to flush current content before restoring", err)
      }

      await restoreStashedDraftToComposer(workspaceId, scope, id)
      // Re-read the newly-pointed draft into the editor (decrypting it for E2E).
      composer.markNeedsRehydrate()
    },
    [composer, workspaceId, scope, stashedDrafts.claimableDrafts]
  )

  const handleDeleteStashed = useCallback(
    async (id: string) => {
      await stashedDrafts.deleteStashedDraft(id)
    },
    [stashedDrafts]
  )

  // Auto-restore when the URL carries `?stash=<id>` — how the /drafts explorer
  // deep-links to a specific snapshot. The dedup ref prevents the same id firing
  // twice within one mount if React re-runs the effect, and the param is stripped
  // only after the restore resolves so a thrown error doesn't silently eat the
  // deep link (a refresh can retry).
  const [searchParams, setSearchParams] = useSearchParams()
  const pendingStashRestoreRef = useRef<string | null>(null)
  useEffect(() => {
    const stashId = searchParams.get("stash")
    if (!stashId || !scope || !composer.isLoaded) return
    // Two gates, both load-bearing. The row must belong to THIS scope
    // (`claimableDrafts`, not the landing-site-wide pile): restoring a foreign id
    // would point this scope's loaded draft at another scope's row, splitting one
    // draft across two composers. And this composer must hold the scope's claim —
    // a board card and the conversation panel's footer mount the same scope, so
    // membership alone let both restore. A non-claimant skips WITHOUT stripping,
    // leaving the param for the claimant.
    if (!composer.isStashClaimant) return
    if (!stashedDrafts.claimableDrafts.some((draft) => draft.id === stashId)) return
    if (pendingStashRestoreRef.current === stashId) return

    pendingStashRestoreRef.current = stashId

    handleRestoreStashed(stashId).then(
      () => {
        const nextParams = new URLSearchParams(searchParams)
        nextParams.delete("stash")
        setSearchParams(nextParams, { replace: true })
      },
      (err) => {
        // Keep the param so a refresh can retry; dedup ref still prevents
        // a loop within this mount.
        console.error("Failed to auto-restore stashed draft from URL", err)
      }
    )
  }, [
    searchParams,
    setSearchParams,
    scope,
    composer.isLoaded,
    composer.isStashClaimant,
    stashedDrafts.claimableDrafts,
    handleRestoreStashed,
  ])

  return {
    drafts: stashedDrafts.drafts,
    claimableDrafts: stashedDrafts.claimableDrafts,
    originByDraftId: stashedDrafts.originByDraftId,
    setPileOpen: stashedDrafts.setPileOpen,
    handleStashDraft,
    handleRestoreStashed,
    handleDeleteStashed,
  }
}
