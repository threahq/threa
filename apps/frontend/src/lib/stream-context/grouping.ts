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
