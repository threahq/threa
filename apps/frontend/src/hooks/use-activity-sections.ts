import { useMemo } from "react"
import type { Activity } from "@threahq/types"

/**
 * Unread from the viewer's perspective. Self rows are inserted already-read by
 * the backend and never count, whatever `readAt` holds.
 */
export function isActivityUnread(activity: Activity): boolean {
  return !activity.isSelf && !activity.readAt
}

/**
 * Ids latched into the Unread section, per workspace. Module-scoped on purpose:
 * the section a row sits in must survive leaving the Activity page and coming
 * back (the whole point is that opening a row doesn't make it disappear), and
 * must reset on a hard refresh. A component ref would reset on every unmount; a
 * persisted store would never reset.
 */
const latchByWorkspace = new Map<string, Set<string>>()

/** Drop every latched membership. Tests only — a refresh is the real reset. */
export function resetActivitySectionLatch(): void {
  latchByWorkspace.clear()
}

export interface ActivitySections {
  /** Rows latched into the Unread section, feed order (createdAt desc). */
  unread: Activity[]
  /** Everything else, feed order. */
  read: Activity[]
  /** Rows in {@link unread} that are still genuinely unread. */
  stillUnreadCount: number
}

/**
 * Split the feed into the two stacked sections. A row enters Unread the first
 * time it is seen unread and stays there for the rest of the visit — reading it
 * restyles the row in place instead of moving it under the reader's eye. New
 * arrivals prepend for free: the feed is already `createdAt` desc, so
 * partitioning it preserves the frozen relative order of everything already
 * latched.
 */
export function partitionActivitySections(workspaceId: string, activities: readonly Activity[]): ActivitySections {
  let latch = latchByWorkspace.get(workspaceId)
  if (!latch) {
    latch = new Set()
    latchByWorkspace.set(workspaceId, latch)
  }

  const unread: Activity[] = []
  const read: Activity[] = []
  let stillUnreadCount = 0

  for (const activity of activities) {
    if (isActivityUnread(activity)) {
      latch.add(activity.id)
      stillUnreadCount++
    }
    if (latch.has(activity.id)) unread.push(activity)
    else read.push(activity)
  }

  return { unread, read, stillUnreadCount }
}

export function useActivitySections(workspaceId: string, activities: Activity[] | undefined): ActivitySections {
  return useMemo(() => partitionActivitySections(workspaceId, activities ?? []), [workspaceId, activities])
}
