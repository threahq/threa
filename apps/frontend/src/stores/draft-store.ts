import { useSyncExternalStore } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { db, type CachedDraft, type ComposerLoaded, type DraftScratchpad } from "@/db"

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

function useArrayStoreHook<T>(queryFn: () => Promise<T[]> | T[], deps: unknown[], cached: T[]): T[] {
  const live = useLiveQuery(queryFn, deps, cached) ?? []
  if (live.length === 0 && cached.length > 0) return cached
  return live
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
    () => (workspaceId ? db.draftScratchpads.where("workspaceId").equals(workspaceId).toArray() : []),
    [workspaceId],
    cached
  )
}

export function useDraftsFromStore(workspaceId: string | undefined): CachedDraft[] {
  useDraftCacheSignal(workspaceId)
  const cached = workspaceId ? (cache.drafts.get(workspaceId) ?? []) : []
  return useArrayStoreHook(
    () => (workspaceId ? db.drafts.where("workspaceId").equals(workspaceId).toArray() : []),
    [workspaceId],
    cached
  )
}

export function useComposerLoadedFromStore(workspaceId: string | undefined): ComposerLoaded[] {
  useDraftCacheSignal(workspaceId)
  const cached = workspaceId ? (cache.loaded.get(workspaceId) ?? []) : []
  return useArrayStoreHook(
    () => (workspaceId ? db.composerLoaded.where("workspaceId").equals(workspaceId).toArray() : []),
    [workspaceId],
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

export function upsertDraftInCache(workspaceId: string, draft: CachedDraft): void {
  const drafts = cache.drafts.get(workspaceId) ?? []
  const next = [...drafts]
  const index = next.findIndex((candidate) => candidate.id === draft.id)
  if (index === -1) {
    next.push(draft)
  } else {
    next[index] = draft
  }
  seedDraftCache(workspaceId, {
    scratchpads: cache.scratchpads.get(workspaceId) ?? [],
    drafts: next,
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
