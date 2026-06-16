import { createContext, useContext, useSyncExternalStore } from "react"

export type SyncStatus = "idle" | "syncing" | "synced" | "stale" | "error"
export interface SyncErrorRecord {
  status: number | null
  error: Error
}

type Listener = () => void

/**
 * Transient session-state store for per-resource sync status.
 * Not persisted to IndexedDB — sync status resets on page reload.
 *
 * Keys follow the convention:
 *   "workspace:{workspaceId}" — workspace bootstrap sync
 *   "stream:{streamId}"      — stream bootstrap sync
 */
export class SyncStatusStore {
  private statuses = new Map<string, SyncStatus>()
  private errors = new Map<string, SyncErrorRecord>()
  private cachedSnapshot: { statuses: ReadonlyMap<string, SyncStatus>; errors: ReadonlyMap<string, SyncErrorRecord> } =
    {
      statuses: new Map(),
      errors: new Map(),
    }
  private listeners = new Map<string, Set<Listener>>()
  private globalListeners = new Set<Listener>()

  get(key: string): SyncStatus {
    return this.statuses.get(key) ?? "idle"
  }

  set(key: string, status: SyncStatus): void {
    if (this.statuses.get(key) === status) return
    this.statuses.set(key, status)
    this.notify(key)
  }

  getError(key: string): SyncErrorRecord | null {
    return this.errors.get(key) ?? null
  }

  setError(key: string, error: SyncErrorRecord | null): void {
    const current = this.errors.get(key) ?? null
    if (
      current?.status === error?.status &&
      current?.error?.message === error?.error.message &&
      current?.error?.name === error?.error.name
    ) {
      return
    }

    if (error) {
      this.errors.set(key, error)
    } else {
      this.errors.delete(key)
    }
    this.notify(key)
  }

  setAllStale(): void {
    for (const key of this.statuses.keys()) {
      this.statuses.set(key, "stale")
    }
    this.refreshSnapshot()
    for (const [, listeners] of this.listeners) {
      for (const listener of listeners) listener()
    }
    for (const listener of this.globalListeners) listener()
  }

  subscribe(key: string, listener: Listener): () => void {
    let set = this.listeners.get(key)
    if (!set) {
      set = new Set()
      this.listeners.set(key, set)
    }
    set.add(listener)
    return () => {
      set!.delete(listener)
      if (set!.size === 0) this.listeners.delete(key)
    }
  }

  subscribeGlobal(listener: Listener): () => void {
    this.globalListeners.add(listener)
    return () => this.globalListeners.delete(listener)
  }

  snapshot(): { statuses: ReadonlyMap<string, SyncStatus>; errors: ReadonlyMap<string, SyncErrorRecord> } {
    return this.cachedSnapshot
  }

  /** Check if any resource is currently syncing */
  isAnySyncing(): boolean {
    for (const status of this.statuses.values()) {
      if (status === "syncing") return true
    }
    return false
  }

  private notify(key: string): void {
    this.refreshSnapshot()
    const listeners = this.listeners.get(key)
    if (listeners) {
      for (const listener of listeners) listener()
    }
    for (const listener of this.globalListeners) listener()
  }

  private refreshSnapshot(): void {
    this.cachedSnapshot = {
      statuses: new Map(this.statuses),
      errors: new Map(this.errors),
    }
  }
}

export const SyncStatusContext = createContext<SyncStatusStore | null>(null)

function useSyncStatusStore(): SyncStatusStore {
  const store = useContext(SyncStatusContext)
  if (!store) throw new Error("useSyncStatus must be used within a SyncStatusContext provider")
  return store
}

/**
 * Subscribe to sync status for a specific resource key.
 * Returns the current SyncStatus and re-renders only when that key changes.
 */
export function useSyncStatus(key: string): SyncStatus {
  const store = useSyncStatusStore()
  return useSyncExternalStore(
    (cb) => store.subscribe(key, cb),
    () => store.get(key)
  )
}

export function useSyncError(key: string): SyncErrorRecord | null {
  const store = useSyncStatusStore()
  return useSyncExternalStore(
    (cb) => store.subscribe(key, cb),
    () => store.getError(key)
  )
}

export function useSyncSnapshot(): {
  statuses: ReadonlyMap<string, SyncStatus>
  errors: ReadonlyMap<string, SyncErrorRecord>
} {
  const store = useSyncStatusStore()
  return useSyncExternalStore(
    (cb) => store.subscribeGlobal(cb),
    () => store.snapshot()
  )
}

/** Subscribe to whether any resource is currently syncing. */
export function useIsAnySyncing(): boolean {
  const store = useSyncStatusStore()
  return useSyncExternalStore(
    (cb) => store.subscribeGlobal(cb),
    () => store.isAnySyncing()
  )
}
