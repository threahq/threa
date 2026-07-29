import type { ContextItem } from "./types"

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/**
 * A timeline milestone label for a date, relative to `now`, in device-local
 * time (INV-42): "Today", "Yesterday", a weekday within the last week, then a
 * "Mon D" date (with the year once it differs from now).
 */
export function dayBucketLabel(date: Date, now: Date): string {
  const diffDays = Math.round((startOfDay(now).getTime() - startOfDay(date).getTime()) / 86_400_000)
  if (diffDays <= 0) return "Today"
  if (diffDays === 1) return "Yesterday"
  if (diffDays < 7) return date.toLocaleDateString(undefined, { weekday: "long" })
  const sameYear = date.getFullYear() === now.getFullYear()
  return date.toLocaleDateString(
    undefined,
    sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" }
  )
}

export interface TimelineGroup {
  label: string
  items: ContextItem[]
}

/**
 * Bucket already-sorted (newest-first) items into consecutive day groups for
 * the timeline. Runs in render order, so adjacent same-day items collapse into
 * one milestone without a separate sort pass.
 */
export function groupItemsByDay(items: ContextItem[], now: Date): TimelineGroup[] {
  const groups: TimelineGroup[] = []
  let current: TimelineGroup | null = null
  for (const item of items) {
    const label = dayBucketLabel(new Date(item.createdAt), now)
    if (!current || current.label !== label) {
      current = { label, items: [] }
      groups.push(current)
    }
    current.items.push(item)
  }
  return groups
}

/**
 * Index of the day marker to land on when jumping to a date, into the FLAT
 * child list the timeline renders — which interleaves a marker before each
 * group, so a row index lands a row or two off. `-1` when nothing is early
 * enough.
 *
 * Rows are newest-first, so the first group at or before the day's end is the
 * nearest-earlier landing spot; dates here are sparse and most days hold
 * nothing. Lives beside the grouping it indexes so the paged and non-paged jump
 * paths can't drift apart (INV-35).
 */
export function markerIndexForDate(items: ContextItem[], endOfDayMs: number, now: Date): number {
  let flatIndex = 0
  for (const group of groupItemsByDay(items, now)) {
    if (Date.parse(group.items[0].createdAt) < endOfDayMs) return flatIndex
    flatIndex += 1 + group.items.length
  }
  return -1
}

/**
 * Flat index of the OLDEST day marker, or `-1` when there are no items.
 *
 * Where a jump lands once it runs past the start of history: asking for a year
 * ago means "as far back as you can go", so the list travels to its own
 * beginning rather than refusing to move.
 */
export function oldestMarkerIndex(items: ContextItem[], now: Date): number {
  let markerIndex = -1
  let flatIndex = 0
  for (const group of groupItemsByDay(items, now)) {
    markerIndex = flatIndex
    flatIndex += 1 + group.items.length
  }
  return markerIndex
}
