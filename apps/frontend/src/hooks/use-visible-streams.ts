import { useEffect } from "react"
import { createVisibleStreamRegistry, publishVisibleStreams, type VisibleStreamRegistry } from "@/lib/visible-streams"

/**
 * One registry per tab, publishing to the shared presence cache. Ownership
 * rule: ONLY the focused tab writes the entry. The cache is last-writer-wins
 * across tabs and the SW reads it as "what the focused client is viewing" —
 * an unfocused tab publishing its own set (a stream opened in a background
 * tab, a conversation panel whose data resolves after a tab switch) would
 * clobber the focused tab's set and silently suppress pushes the user cannot
 * see. A tab that registers while backgrounded publishes on its next focus
 * via the listener below, which also heals the entry after a tab closes
 * without cleanup: whichever Threa tab the user focuses next overwrites it,
 * and until one is focused the SW's focused-client gate keeps it inert.
 */
let sharedRegistry: VisibleStreamRegistry | null = null
function getRegistry(): VisibleStreamRegistry {
  if (!sharedRegistry) {
    sharedRegistry = createVisibleStreamRegistry((ids) => {
      if (!document.hasFocus()) return
      void publishVisibleStreams(ids)
    })
    window.addEventListener("focus", () => sharedRegistry?.republish())
  }
  return sharedRegistry
}

/**
 * Marks the given streams as on-screen for push suppression while the calling
 * component is mounted (see lib/visible-streams.ts). Register from surfaces
 * that actually render a stream's messages: the workspace layout (URL stream +
 * bare-stream panels), the conversation panel (its resolved stream ids), and
 * viewport-visible board cards.
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
