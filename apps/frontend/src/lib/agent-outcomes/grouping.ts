import { formatDayDivider, localStartOfDayMs } from "@/lib/dates"
import type { OutcomeItem } from "./items"

export interface OutcomeDayGroup {
  /** Stable React key: `now`, `later`, or the local start-of-day in ms. */
  key: string
  label: string
  items: OutcomeItem[]
}

/** Days ahead beyond which a scheduled outcome collapses into the "Later" bucket. */
const LATER_HORIZON_DAYS = 6

const NOW_KEY = "now"
const LATER_KEY = "later"

const INTERMEDIATE_RANK = 2

function rankOf(key: string, todayKey: string): number {
  if (key === NOW_KEY) return 0
  if (key === todayKey) return 1
  if (key === LATER_KEY) return 3
  return INTERMEDIATE_RANK
}

function bucketFor(item: OutcomeItem, now: Date): { key: string; label: string } {
  const occursAt = new Date(item.occursAt)

  // Outstanding work whose moment has passed is the thing the user acts on
  // first — an overdue follow-up and a delegation already moving belong side by
  // side, not filed under their calendar days.
  if (!item.isSettled && occursAt.getTime() <= now.getTime()) {
    return { key: NOW_KEY, label: "Now" }
  }

  const dayMs = localStartOfDayMs(occursAt)
  const daysAhead = Math.round((dayMs - localStartOfDayMs(now)) / 86_400_000)
  if (daysAhead > LATER_HORIZON_DAYS) {
    return { key: LATER_KEY, label: "Later" }
  }

  return { key: String(dayMs), label: formatDayDivider(occursAt, now) }
}

/**
 * Day buckets for the outcomes list, in the device's local calendar (INV-42).
 * `Now` leads and `Later` trails; the calendar days in between run
 * chronologically regardless of the direction the server paged `occursAt` in.
 */
export function groupOutcomesByDay(items: OutcomeItem[], now: Date = new Date()): OutcomeDayGroup[] {
  const byKey = new Map<string, OutcomeDayGroup>()
  const order: string[] = []

  for (const item of items) {
    const { key, label } = bucketFor(item, now)
    const existing = byKey.get(key)
    if (existing) {
      existing.items.push(item)
      continue
    }
    byKey.set(key, { key, label, items: [item] })
    order.push(key)
  }

  const todayKey = String(localStartOfDayMs(now))
  return order
    .map((key, index) => ({ key, index, rank: rankOf(key, todayKey) }))
    .sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank
      // Intermediate buckets are keyed by their local start-of-day, so the page
      // can arrive DESC and still read forwards.
      if (a.rank === INTERMEDIATE_RANK) return Number(a.key) - Number(b.key)
      return a.index - b.index
    })
    .map(({ key }) => byKey.get(key)!)
}
