import { useCallback, useMemo } from "react"
import { db, generateLocalDraftId, type CachedDraft, type DraftAttachment } from "@/db"
import {
  deleteDraftFromCache,
  hasSeededDraftCache,
  upsertDraftInCache,
  useComposerLoadedFromStore,
  useDraftsFromStore,
} from "@/stores/draft-store"
import { enqueueDraftUpsert, syncDraftRemoval } from "@/sync/draft-sync"
import { useOptionalSyncEngine } from "@/sync/sync-engine"
import type { JSONContent } from "@threa/types"
import { isEmptyContent } from "@/lib/prosemirror-utils"

// Re-exported so components (which cannot import from `@/db` per INV-15) can
// still get the row type they render without reaching into the data layer.
// A "stashed" draft is just a `CachedDraft` that isn't the loaded one for its
// scope.
export type { CachedDraft }

export interface StashDraftInput {
  contentJson: JSONContent
  attachments?: DraftAttachment[]
}

export interface UseStashedDraftsResult {
  /** Stashed drafts for the current scope (every draft except the loaded one), newest first. */
  drafts: CachedDraft[]
  /** True once the draft cache has been seeded (used to suppress empty-flash in the picker). */
  isLoaded: boolean
  /**
   * Persist a new stashed draft. Refuses to save when the content is empty
   * and no attachments are present — callers should still honour a no-op
   * locally (e.g. skip the toast) so the UX doesn't confirm a save that
   * didn't happen.
   */
  stashDraft: (input: StashDraftInput) => Promise<CachedDraft | null>
  /** Fetch-and-delete: returns the row so the caller can load it into the composer. */
  restoreStashedDraft: (id: string) => Promise<CachedDraft | null>
  /** Delete without restoring. */
  deleteStashedDraft: (id: string) => Promise<void>
}

/**
 * Persist a new stashed draft (a `CachedDraft` left unloaded). Returns `null`
 * (no DB write) when both the content is empty and there are no attachments —
 * callers should treat the null return as a silent no-op (e.g. skip the
 * confirmation toast).
 */
export async function createStashedDraft(
  workspaceId: string,
  scope: string | undefined,
  input: StashDraftInput
): Promise<CachedDraft | null> {
  if (!workspaceId || !scope) return null
  const hasContent = !isEmptyContent(input.contentJson)
  const hasAttachments = (input.attachments?.length ?? 0) > 0
  if (!hasContent && !hasAttachments) return null

  const row: CachedDraft = {
    id: generateLocalDraftId(),
    workspaceId,
    scope,
    contentJson: input.contentJson,
    attachments: input.attachments ?? [],
    clientUpdatedAt: Date.now(),
  }
  await db.drafts.add(row)
  upsertDraftInCache(workspaceId, row)
  // Mirror the new stash to the backend so it roams across devices (Stage 3).
  await enqueueDraftUpsert(workspaceId, row.id)
  return row
}

/**
 * Fetch-and-delete a draft by id. Returns the row so the caller can hydrate the
 * composer; returns `null` if the id is missing (idempotent).
 *
 * Wrapped in a Dexie rw transaction so the get + delete are atomic against
 * concurrent tabs — without it, two tabs opening the same `?stash=` link
 * could both read the row before either deletes, and both would restore
 * the same content into their composers.
 */
export async function popStashedDraft(id: string): Promise<CachedDraft | null> {
  const row = await db.transaction("rw", db.drafts, async () => {
    const found = await db.drafts.get(id)
    if (!found) return null
    await db.drafts.delete(id)
    return found
  })
  if (row) {
    deleteDraftFromCache(row.workspaceId, id)
    // Restore is copy-then-pop (the content is reloaded into the composer as a
    // fresh draft), so the popped stash row is removed server-side too (Stage 3).
    await syncDraftRemoval(row.workspaceId, row.id, row.baseVersion)
  }
  return row
}

/** Delete a draft without restoring it. */
export async function deleteStashedDraftById(id: string): Promise<void> {
  const row = await db.drafts.get(id)
  await db.drafts.delete(id)
  if (row) {
    deleteDraftFromCache(row.workspaceId, id)
    await syncDraftRemoval(row.workspaceId, row.id, row.baseVersion)
  }
}

/**
 * Query + mutate the stashed drafts for a specific scope (a stream or a thread's
 * parent message) — every draft for the scope except the one loaded into the
 * composer. Pass `undefined` for `scope` when the host is still resolving what
 * scope to target — the hook returns an empty list and silently no-ops
 * mutations rather than throw.
 *
 * The mutation methods are thin wrappers over the module-level helpers
 * (`createStashedDraft`, `popStashedDraft`, `deleteStashedDraftById`) so the
 * mutation behavior is testable without `renderHook`.
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

  const stashDraft = useCallback(
    async (input: StashDraftInput) => {
      const row = await createStashedDraft(workspaceId, scope, input)
      if (row) syncEngine?.kickOperationQueue()
      return row
    },
    [workspaceId, scope, syncEngine]
  )
  const restoreStashedDraft = useCallback(
    async (id: string) => {
      const row = await popStashedDraft(id)
      if (row) syncEngine?.kickOperationQueue()
      return row
    },
    [syncEngine]
  )
  const deleteStashedDraft = useCallback(
    async (id: string) => {
      await deleteStashedDraftById(id)
      syncEngine?.kickOperationQueue()
    },
    [syncEngine]
  )

  return { drafts, isLoaded, stashDraft, restoreStashedDraft, deleteStashedDraft }
}
