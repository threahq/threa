import { useSyncExternalStore } from "react"

// Threads the sidebar has shown in an automatic section this page load, per
// workspace. A held thread keeps its row after it's read, so reading one never
// pulls it out from under the viewer; it leaves when released (the row's Clear)
// or on reload. Page-scoped on purpose: the sidebar unmounts on mobile, and the
// hold must outlive that.

const EMPTY: ReadonlySet<string> = new Set()
const held = new Map<string, ReadonlySet<string>>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

/** Hold these threads; notifies only when one is new. */
export function holdSidebarThreads(workspaceId: string, threadIds: Iterable<string>): void {
  const current = held.get(workspaceId) ?? EMPTY
  let next: Set<string> | null = null
  for (const id of threadIds) {
    if (current.has(id) || next?.has(id)) continue
    next ??= new Set(current)
    next.add(id)
  }
  if (!next) return
  held.set(workspaceId, next)
  emit()
}

export function releaseSidebarThread(workspaceId: string, threadId: string): void {
  const current = held.get(workspaceId)
  if (!current?.has(threadId)) return
  const next = new Set(current)
  next.delete(threadId)
  held.set(workspaceId, next)
  emit()
}

export function resetSidebarHeldThreadsStore(): void {
  if (held.size === 0) return
  held.clear()
  emit()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useHeldSidebarThreads(workspaceId: string): ReadonlySet<string> {
  return useSyncExternalStore(
    subscribe,
    () => held.get(workspaceId) ?? EMPTY,
    () => EMPTY
  )
}
