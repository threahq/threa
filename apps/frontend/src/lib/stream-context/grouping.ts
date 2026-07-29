import type { ContextItem } from "./types"

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

// `date.toLocaleDateString(undefined, opts)` builds a fresh `Intl.DateTimeFormat`
// on every call — 0.024 ms in V8 against 0.0005 ms for a reused one. Labelling is
// per item, so at 500 rows that was ~12 ms a pass, and this runs on every render
// of both panels plus twice per date jump. Same locale resolution as the
// `undefined` argument it replaces, so device-local (INV-42) is unchanged.
const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: "long" })
const MONTH_DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" })
const MONTH_DAY_YEAR = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" })

/**
 * A timeline milestone label for a date, relative to `now`, in device-local
 * time (INV-42): "Today", "Yesterday", a weekday within the last week, then a
 * "Mon D" date (with the year once it differs from now).
 */
export function dayBucketLabel(date: Date, now: Date): string {
  const diffDays = Math.round((startOfDay(now).getTime() - startOfDay(date).getTime()) / 86_400_000)
  if (diffDays <= 0) return "Today"
  if (diffDays === 1) return "Yesterday"
  if (diffDays < 7) return WEEKDAY.format(date)
  const sameYear = date.getFullYear() === now.getFullYear()
  return (sameYear ? MONTH_DAY : MONTH_DAY_YEAR).format(date)
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
 * Flat index of the OLDEST ITEM, or `-1` when there are no items.
 *
 * Where a jump lands once it runs past the start of history: asking for a year
 * ago means "show me the oldest thing there is". Deliberately the last row and
 * not the last day's marker — a stream having a busy day puts hundreds of rows
 * under one marker, and landing on that marker leaves the user near the top of
 * the list, looking at the newest of those rows and no closer to what they
 * asked for.
 */
export function oldestItemIndex(items: ContextItem[], now: Date): number {
  if (items.length === 0) return -1
  // Markers are interleaved one per group, so the last row sits at
  // (rows + groups - 1) in the flat child list.
  return items.length + groupItemsByDay(items, now).length - 1
}
