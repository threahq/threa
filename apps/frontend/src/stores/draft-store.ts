import { useSyncExternalStore } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { db, type CachedDraft, type ComposerLoaded, type DraftScratchpad } from "@/db"
import { useBatchedValue } from "./apply-window"

const cache = {
  scratchpads: new Map<string, DraftScratchpad[]>(),
  drafts: new Map<string, CachedDraft[]>(),
  loaded: new Map<string, ComposerLoaded[]>(),
}

const readyWorkspaces = new Set<string>()
const cacheVersion = new Map<string, number>()
const cacheListeners = new Map<string, Set<() => void>>()

function bumpVersion(workspaceId: string) {
  cacheVersion.set(workspaceId, (cacheVersion.get(workspaceId) ?? 0) + 1)
}

function emitDraftCacheChange(workspaceId: string): void {
  const listeners = cacheListeners.get(workspaceId)
  if (!listeners) return
  for (const listener of listeners) listener()
}

function subscribeDraftCache(workspaceId: string | undefined, listener: () => void): () => void {
  if (!workspaceId) return () => {}

  let listeners = cacheListeners.get(workspaceId)
  if (!listeners) {
    listeners = new Set()
    cacheListeners.set(workspaceId, listeners)
  }

  listeners.add(listener)
  return () => {
    const currentListeners = cacheListeners.get(workspaceId)
    if (!currentListeners) return
    currentListeners.delete(listener)
    if (currentListeners.size === 0) {
      cacheListeners.delete(workspaceId)
    }
  }
}

function getDraftCacheSnapshot(workspaceId: string | undefined): number {
  return workspaceId ? (cacheVersion.get(workspaceId) ?? 0) : 0
}

function useDraftCacheSignal(workspaceId: string | undefined): number {
  return useSyncExternalStore(
    (listener) => subscribeDraftCache(workspaceId, listener),
    () => getDraftCacheSnapshot(workspaceId),
    () => getDraftCacheSnapshot(workspaceId)
  )
}

function useArrayStoreHook<T>(workspaceId: string | undefined, queryFn: () => Promise<T[]> | T[], cached: T[]): T[] {
  const live = useLiveQuery(queryFn, [workspaceId], cached) ?? []
  const resolved = live.length === 0 && cached.length > 0 ? cached : live
  return useBatchedValue(resolved, workspaceId)
}

export function hasSeededDraftCache(workspaceId: string): boolean {
  return (
    readyWorkspaces.has(workspaceId) &&
    cache.scratchpads.has(workspaceId) &&
    cache.drafts.has(workspaceId) &&
    cache.loaded.has(workspaceId)
  )
}

export function resetDraftStoreCache(): void {
  const workspaceIds = new Set([...cacheVersion.keys(), ...cacheListeners.keys()])
  cache.scratchpads.clear()
  cache.drafts.clear()
  cache.loaded.clear()
  readyWorkspaces.clear()
  cacheVersion.clear()
  for (const workspaceId of workspaceIds) {
    emitDraftCacheChange(workspaceId)
  }
}

export function seedDraftCache(
  workspaceId: string,
  data: { scratchpads: DraftScratchpad[]; drafts: CachedDraft[]; loaded: ComposerLoaded[] }
): void {
  bumpVersion(workspaceId)
  cache.scratchpads.set(workspaceId, data.scratchpads)
  cache.drafts.set(workspaceId, data.drafts)
  cache.loaded.set(workspaceId, data.loaded)
  readyWorkspaces.add(workspaceId)
  emitDraftCacheChange(workspaceId)
}

export async function seedDraftCacheFromIdb(workspaceId: string): Promise<void> {
  const versionBefore = cacheVersion.get(workspaceId) ?? 0
  const [scratchpads, drafts, loaded] = await Promise.all([
    db.draftScratchpads.where("workspaceId").equals(workspaceId).toArray(),
    db.drafts.where("workspaceId").equals(workspaceId).toArray(),
    db.composerLoaded.where("workspaceId").equals(workspaceId).toArray(),
  ])

  if ((cacheVersion.get(workspaceId) ?? 0) !== versionBefore) return

  seedDraftCache(workspaceId, { scratchpads, drafts, loaded })
}

export function useDraftScratchpadsFromStore(workspaceId: string | undefined): DraftScratchpad[] {
  useDraftCacheSignal(workspaceId)
  const cached = workspaceId ? (cache.scratchpads.get(workspaceId) ?? []) : []
  return useArrayStoreHook(
    workspaceId,
    () => (workspaceId ? db.draftScratchpads.where("workspaceId").equals(workspaceId).toArray() : []),
    cached
  )
}

export function useDraftsFromStore(workspaceId: string | undefined): CachedDraft[] {
  useDraftCacheSignal(workspaceId)
  const cached = workspaceId ? (cache.drafts.get(workspaceId) ?? []) : []
  return useArrayStoreHook(
    workspaceId,
    () => (workspaceId ? db.drafts.where("workspaceId").equals(workspaceId).toArray() : []),
    cached
  )
}

export function useComposerLoadedFromStore(workspaceId: string | undefined): ComposerLoaded[] {
  useDraftCacheSignal(workspaceId)
  const cached = workspaceId ? (cache.loaded.get(workspaceId) ?? []) : []
  return useArrayStoreHook(
    workspaceId,
    () => (workspaceId ? db.composerLoaded.where("workspaceId").equals(workspaceId).toArray() : []),
    cached
  )
}

export function upsertDraftScratchpadInCache(workspaceId: string, draft: DraftScratchpad): void {
  const drafts = cache.scratchpads.get(workspaceId) ?? []
  const next = [...drafts]
  const index = next.findIndex((candidate) => candidate.id === draft.id)
  if (index === -1) {
    next.push(draft)
  } else {
    next[index] = draft
  }
  seedDraftCache(workspaceId, {
    scratchpads: next,
    drafts: cache.drafts.get(workspaceId) ?? [],
    loaded: cache.loaded.get(workspaceId) ?? [],
  })
}

export function deleteDraftScratchpadFromCache(workspaceId: string, draftId: string): void {
  seedDraftCache(workspaceId, {
    scratchpads: (cache.scratchpads.get(workspaceId) ?? []).filter((draft) => draft.id !== draftId),
    drafts: cache.drafts.get(workspaceId) ?? [],
    loaded: cache.loaded.get(workspaceId) ?? [],
  })
}

/** Return a copy of `drafts` with `draft` upserted by id (pure; no cache signal). */
function withDraftUpserted(drafts: CachedDraft[], draft: CachedDraft): CachedDraft[] {
  const next = [...drafts]
  const index = next.findIndex((candidate) => candidate.id === draft.id)
  if (index === -1) {
    next.push(draft)
  } else {
    next[index] = draft
  }
  return next
}

export function upsertDraftInCache(workspaceId: string, draft: CachedDraft): void {
  seedDraftCache(workspaceId, {
    scratchpads: cache.scratchpads.get(workspaceId) ?? [],
    drafts: withDraftUpserted(cache.drafts.get(workspaceId) ?? [], draft),
    loaded: cache.loaded.get(workspaceId) ?? [],
  })
}

export function deleteDraftFromCache(workspaceId: string, draftId: string): void {
  seedDraftCache(workspaceId, {
    scratchpads: cache.scratchpads.get(workspaceId) ?? [],
    drafts: (cache.drafts.get(workspaceId) ?? []).filter((draft) => draft.id !== draftId),
    loaded: cache.loaded.get(workspaceId) ?? [],
  })
}

/**
 * Upsert a draft AND point the scope's composer-loaded pointer at it in a single
 * cache signal. Used when a brand-new loaded draft is created: doing the draft
 * insert and the pointer set as one update means a live reader never observes a
 * frame where the draft exists but no pointer references it — which would render
 * the just-created draft as a stash entry for a tick (it isn't filtered out as
 * "loaded" until the pointer lands).
 */
export function upsertLoadedDraftInCache(workspaceId: string, draft: CachedDraft, scope: string): void {
  const loaded = (cache.loaded.get(workspaceId) ?? []).filter((row) => row.scope !== scope)
  loaded.push({ scope, workspaceId, draftId: draft.id })
  seedDraftCache(workspaceId, {
    scratchpads: cache.scratchpads.get(workspaceId) ?? [],
    drafts: withDraftUpserted(cache.drafts.get(workspaceId) ?? [], draft),
    loaded,
  })
}

/**
 * Re-key a draft in the cache (`fromId` → `toRow.id`) and, when `repointScope`
 * is set, point that scope's composer-loaded pointer at the new id — all in ONE
 * cache signal. Mirrors `upsertLoadedDraftInCache` for the id-migration path
 * (server split, remote-delete preserve): doing delete-old + insert-new + repoint
 * as three separate signals leaves intermediate frames where the loaded draft is
 * absent from the cache, so a user typing during a split sees the composer flash
 * empty. One `seedDraftCache` keeps the observed state consistent.
 */
export function migrateLoadedDraftInCache(
  workspaceId: string,
  fromId: string,
  toRow: CachedDraft,
  repointScope: string | null
): void {
  const drafts = withDraftUpserted(
    (cache.drafts.get(workspaceId) ?? []).filter((draft) => draft.id !== fromId),
    toRow
  )
  let loaded = cache.loaded.get(workspaceId) ?? []
  if (repointScope) {
    loaded = loaded.filter((row) => row.scope !== repointScope)
    loaded.push({ scope: repointScope, workspaceId, draftId: toRow.id })
  }
  seedDraftCache(workspaceId, {
    scratchpads: cache.scratchpads.get(workspaceId) ?? [],
    drafts,
    loaded,
  })
}

/**
 * Re-scope a draft in the cache (same id, `oldScope` → `newRow.scope`) in ONE
 * cache signal — the read-side of thread re-pointing (a `draft:upserted` whose
 * scope changed) and draft-stream promotion. When `movedToScope` is set the
 * draft was the loaded one under `oldScope`, so its composer-loaded pointer
 * moves with it: the old-scope pointer is dropped and a new-scope pointer added.
 * Doing the row replace and the pointer move as a single `seedDraftCache` keeps
 * a reader from ever observing the draft under two scopes (old pointer still
 * present + new row) or under none.
 */
export function migrateDraftScopeInCache(
  workspaceId: string,
  oldScope: string,
  newRow: CachedDraft,
  movedToScope: string | null
): void {
  const drafts = withDraftUpserted(cache.drafts.get(workspaceId) ?? [], newRow)
  let loaded = cache.loaded.get(workspaceId) ?? []
  if (movedToScope) {
    loaded = loaded.filter((row) => row.scope !== oldScope && row.scope !== movedToScope)
    loaded.push({ scope: movedToScope, workspaceId, draftId: newRow.id })
  }
  seedDraftCache(workspaceId, {
    scratchpads: cache.scratchpads.get(workspaceId) ?? [],
    drafts,
    loaded,
  })
}

/**
 * Set (or clear, with `draftId: null`) the composer-loaded pointer for a scope
 * in the in-memory cache. Mirrors the `composerLoaded` IDB row so the composer
 * resolves its checked-out draft synchronously on first paint.
 */
export function setComposerLoadedInCache(workspaceId: string, scope: string, draftId: string | null): void {
  const loaded = cache.loaded.get(workspaceId) ?? []
  const next = loaded.filter((row) => row.scope !== scope)
  next.push({ scope, workspaceId, draftId })
  seedDraftCache(workspaceId, {
    scratchpads: cache.scratchpads.get(workspaceId) ?? [],
    drafts: cache.drafts.get(workspaceId) ?? [],
    loaded: next,
  })
}
