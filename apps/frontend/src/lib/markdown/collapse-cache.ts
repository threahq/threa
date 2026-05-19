import { useSyncExternalStore } from "react"
import { db } from "@/db"
import type { MarkdownBlockKind } from "./markdown-block-context"

/**
 * Synchronous in-memory mirror of the markdown-block + link-preview collapse
 * state. Persisted to localStorage (synchronous, populated at module load
 * before React mounts) and to IndexedDB (legacy + cross-device backup).
 *
 * Why localStorage is the primary persistence layer:
 * IDB reads are async, so on cold boot the in-memory cache was empty until
 * `hydrateCollapseCache()` resolved. `main.tsx` capped the wait at 500ms; on
 * users with large collapse tables or slow `db.open()` paths, React mounted
 * with an empty cache. A collapsible long block renders collapsed (clamped to
 * threshold + half a line) until the persisted override expanding it lands,
 * then flips to fully expanded post-mount — Virtuoso compensates by shifting
 * sibling rows, which the user sees as a "down jump then back" in mega threads
 * where many tall items are above the viewport.
 *
 * Reading localStorage at module-import time eliminates the race entirely:
 * the in-memory cache is populated before any React component can mount, so
 * `useBlockCollapseStore`'s very first snapshot already reflects the user's
 * choices. IDB hydration still runs as a one-time migration for existing
 * users whose state predates localStorage persistence; after the first boot
 * of this code, localStorage is the only path that matters.
 *
 * Cross-tab note: this cache does not subscribe to a change feed, so toggling
 * collapse state in tab A does not propagate to tab B without a reload. Same
 * trade-off as before — collapse state is a per-tab UX preference, and the
 * live-query subscription that previously enabled cross-tab sync was itself
 * the original cause of the first-paint instability.
 *
 * INV-9 exception: module-level singletons are intentional here. The cache
 * is a synchronous source of truth that must be readable from any component
 * without context plumbing, and `useSyncExternalStore` consumers detach
 * listeners on unmount so there's no leak risk.
 */

const BLOCK_COLLAPSE_LS_KEY = "threa:blockCollapse:v1"
const LINK_PREVIEW_LS_KEY = "threa:linkPreviewExpand:v1"

const blockCollapse = new Map<string, boolean>()
const linkPreviewExpand = new Map<string, boolean>()

const blockListeners = new Set<() => void>()
const linkPreviewListeners = new Set<() => void>()

let blockHydrated = false
let linkPreviewHydrated = false
let hydrationPromise: Promise<void> | null = null

function notify(set: Set<() => void>) {
  for (const listener of set) listener()
}

function readPersistedMap(key: string): Record<string, boolean> | null {
  if (typeof localStorage === "undefined") return null
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null
    return parsed as Record<string, boolean>
  } catch {
    return null
  }
}

function writePersistedMap(key: string, map: Map<string, boolean>): void {
  if (typeof localStorage === "undefined") return
  try {
    localStorage.setItem(key, JSON.stringify(Object.fromEntries(map)))
  } catch {
    // Quota exceeded, private mode, etc. The in-memory cache still reflects
    // the user's choice for this tab; losing the persisted copy degrades
    // next-reload behavior but is not actionable here.
  }
}

/**
 * Synchronously populates the in-memory cache from localStorage. Runs at
 * module import time so the very first React render sees the persisted
 * state — see the module banner for why this matters.
 *
 * Sets per-cache hydration flags independently so a missing or corrupt key
 * for one cache doesn't prevent IDB fallback for the other.
 */
function hydrateFromLocalStorageSync(): void {
  const blocks = readPersistedMap(BLOCK_COLLAPSE_LS_KEY)
  const previews = readPersistedMap(LINK_PREVIEW_LS_KEY)
  if (blocks !== null) blockHydrated = true
  if (previews !== null) linkPreviewHydrated = true
  if (blocks) {
    for (const [k, v] of Object.entries(blocks)) {
      if (typeof v === "boolean") {
        blockCollapse.set(k, v)
      }
    }
  }
  if (previews) {
    for (const [k, v] of Object.entries(previews)) {
      if (typeof v === "boolean") {
        linkPreviewExpand.set(k, v)
      }
    }
  }
}

hydrateFromLocalStorageSync()

/**
 * One-time migration from the legacy IDB tables for users whose state
 * predates the localStorage mirror. After the first boot of this code,
 * localStorage carries everything and this is a no-op.
 *
 * Idempotent — repeated callers receive the same in-flight promise. Failures
 * fall through to whatever the cache already holds; we don't want a transient
 * IDB error to block the entire timeline.
 */
export function hydrateCollapseCache(): Promise<void> {
  if (blockHydrated && linkPreviewHydrated) return Promise.resolve()
  if (hydrationPromise) return hydrationPromise
  hydrationPromise = (async () => {
    try {
      const blocks = blockHydrated ? [] : await db.markdownBlockCollapse.toArray()
      const previews = linkPreviewHydrated ? [] : await db.linkPreviewCollapse.toArray()
      // Skip keys already in the cache so a user toggle that races with
      // hydration doesn't get clobbered by the stale persisted value.
      let blockChanged = false
      for (const row of blocks) {
        if (!blockCollapse.has(row.id)) {
          blockCollapse.set(row.id, row.collapsed)
          blockChanged = true
        }
      }
      let previewChanged = false
      for (const row of previews) {
        if (!linkPreviewExpand.has(row.id)) {
          linkPreviewExpand.set(row.id, row.expanded)
          previewChanged = true
        }
      }
      // Mirror the migrated rows into localStorage so subsequent boots are
      // synchronous and skip this IDB read entirely.
      if (blockChanged) writePersistedMap(BLOCK_COLLAPSE_LS_KEY, blockCollapse)
      if (previewChanged) writePersistedMap(LINK_PREVIEW_LS_KEY, linkPreviewExpand)
    } catch {
      // Empty cache → consumers fall back to their default (collapsed when
      // collapsible, otherwise expanded).
    } finally {
      blockHydrated = true
      linkPreviewHydrated = true
      notify(blockListeners)
      notify(linkPreviewListeners)
    }
  })()
  return hydrationPromise
}

export function setBlockCollapse(key: string, messageId: string, kind: MarkdownBlockKind, collapsed: boolean): void {
  blockCollapse.set(key, collapsed)
  notify(blockListeners)
  writePersistedMap(BLOCK_COLLAPSE_LS_KEY, blockCollapse)
  // Keep IDB writes as a backup persistence layer alongside localStorage —
  // matters for users who clear localStorage but keep IDB intact.
  db.markdownBlockCollapse
    .put({
      id: key,
      messageId,
      kind,
      collapsed,
      updatedAt: Date.now(),
    })
    .catch(() => {})
}

export function setLinkPreviewExpand(key: string, messageId: string, previewId: string, expanded: boolean): void {
  linkPreviewExpand.set(key, expanded)
  notify(linkPreviewListeners)
  writePersistedMap(LINK_PREVIEW_LS_KEY, linkPreviewExpand)
  db.linkPreviewCollapse
    .put({
      id: key,
      messageId,
      previewId,
      expanded,
      updatedAt: Date.now(),
    })
    .catch(() => {})
}

function subscribeBlock(callback: () => void): () => void {
  blockListeners.add(callback)
  return () => {
    blockListeners.delete(callback)
  }
}

function subscribeLinkPreview(callback: () => void): () => void {
  linkPreviewListeners.add(callback)
  return () => {
    linkPreviewListeners.delete(callback)
  }
}

/**
 * Subscribes a component to a single block-collapse key. Returns `undefined`
 * when no row has been persisted for the key so consumers can fall back to
 * their default.
 */
export function useBlockCollapseStore(key: string | null): boolean | undefined {
  return useSyncExternalStore(
    subscribeBlock,
    () => (key ? blockCollapse.get(key) : undefined),
    () => undefined
  )
}

export function useLinkPreviewExpandStore(key: string | null): boolean | undefined {
  return useSyncExternalStore(
    subscribeLinkPreview,
    () => (key ? linkPreviewExpand.get(key) : undefined),
    () => undefined
  )
}

/**
 * Test-only helper to reset state between cases. Production code shouldn't
 * call this — the cache lives for the lifetime of the app.
 */
export function __resetCollapseCacheForTests(): void {
  blockCollapse.clear()
  linkPreviewExpand.clear()
  blockListeners.clear()
  linkPreviewListeners.clear()
  blockHydrated = false
  linkPreviewHydrated = false
  hydrationPromise = null
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.removeItem(BLOCK_COLLAPSE_LS_KEY)
      localStorage.removeItem(LINK_PREVIEW_LS_KEY)
    } catch {
      // ignore
    }
  }
}
