import { useCallback, useEffect, useState } from "react"
import type { StreamItemData } from "./types"
import { isUnreadStream } from "./utils"

export interface StickyUnread {
  /** Stream ids held by the Unread section: every stream that has gone unread this
   *  session and not yet been cleared, including ones since read. */
  streamIds: ReadonlySet<string>
  /** True when at least one held stream has already been read — so a "clear" affordance is worth showing. */
  hasReadResidue: boolean
  /** Drop the already-read members; the still-unread ones stay. */
  clearRead: () => void
}

const EMPTY: ReadonlySet<string> = new Set()

function sameMembers(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  for (const id of a) if (!b.has(id)) return false
  return true
}

/**
 * Membership for the dedicated Unread section. A stream enters the moment it goes
 * unread (and isn't muted) and **stays until the session ends or the viewer
 * clears it** — even after it's read — so working through the tray doesn't reflow
 * the sidebar on every read. The set is in-memory and per-session: it resets when
 * the workspace changes or the app reloads, which is what "for this session"
 * means. Stale ids (a held stream that was archived/left) are pruned so the tray
 * can't leak across a long session.
 *
 * `enabled` is whether the layout actually has an Unread section; when false the
 * tray stays empty so nothing is withheld from the normal sections.
 */
export function useStickyUnread(
  workspaceId: string,
  streams: StreamItemData[],
  getUnreadCount: (streamId: string) => number,
  enabled: boolean
): StickyUnread {
  const [held, setHeld] = useState<ReadonlySet<string>>(EMPTY)

  // A new workspace is a new session — start its tray empty.
  useEffect(() => {
    setHeld(EMPTY)
  }, [workspaceId])

  useEffect(() => {
    if (!enabled) {
      setHeld((prev) => (prev.size === 0 ? prev : EMPTY))
      return
    }
    setHeld((prev) => {
      const existing = new Set(streams.map((s) => s.id))
      const next = new Set<string>()
      // Keep previously-held members that still exist (read or not), then add
      // anything currently unread. Pruning to `existing` drops archived/left rows.
      for (const id of prev) if (existing.has(id)) next.add(id)
      for (const s of streams) if (isUnreadStream(s, getUnreadCount(s.id))) next.add(s.id)
      return sameMembers(prev, next) ? prev : next
    })
  }, [enabled, streams, getUnreadCount])

  const clearRead = useCallback(() => {
    setHeld((prev) => {
      const next = new Set<string>()
      for (const s of streams) if (prev.has(s.id) && isUnreadStream(s, getUnreadCount(s.id))) next.add(s.id)
      return sameMembers(prev, next) ? prev : next
    })
  }, [streams, getUnreadCount])

  // Disabling takes effect in the same render rather than waiting for the effect
  // above to clear `held` — so removing the Unread section can't withhold its
  // former members from their home sections for a frame. (The effect still
  // empties `held` so re-enabling starts from a clean tray.)
  const streamIds = enabled ? held : EMPTY

  let hasReadResidue = false
  if (enabled) {
    for (const s of streams) {
      if (held.has(s.id) && !isUnreadStream(s, getUnreadCount(s.id))) {
        hasReadResidue = true
        break
      }
    }
  }

  return { streamIds, hasReadResidue, clearRead }
}
