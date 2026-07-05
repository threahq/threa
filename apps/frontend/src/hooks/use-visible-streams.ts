import { useEffect } from "react"
import { createVisibleStreamRegistry, publishVisibleStreams, type VisibleStreamRegistry } from "@/lib/visible-streams"

/**
 * One registry per tab, publishing to the shared presence cache. The focus
 * listener re-asserts this tab's set when it becomes the focused one — the
 * cache entry is last-writer-wins across tabs, and the service worker only
 * suppresses for the focused client's streams.
 */
let sharedRegistry: VisibleStreamRegistry | null = null
function getRegistry(): VisibleStreamRegistry {
  if (!sharedRegistry) {
    sharedRegistry = createVisibleStreamRegistry((ids) => void publishVisibleStreams(ids))
    window.addEventListener("focus", () => sharedRegistry?.republish())
  }
  return sharedRegistry
}

/**
 * Marks the given streams as on-screen for push suppression while the calling
 * component is mounted (see lib/visible-streams.ts). Register from surfaces
 * that actually render a stream's messages: the workspace layout (URL stream +
 * bare-stream panels) and the conversation panel (its resolved stream ids).
 */
export function useVisibleStreams(streamIds: readonly string[]): void {
  // Key on content, not array identity — callers rebuild the array per render.
  const key = [...streamIds].sort().join(" ")
  useEffect(() => {
    if (typeof window === "undefined" || !("caches" in window)) return
    const ids = key ? key.split(" ") : []
    if (ids.length === 0) return
    return getRegistry().register(ids)
  }, [key])
}
