import { CONTEXT_CATEGORIES, type ContextCategory } from "@threa/types"
import type { CachedStreamContextItem } from "@/db"

export interface ContextRowFilters {
  category?: ContextCategory
  /** Free-text terms; a row must contain every one (case-insensitive). */
  terms?: string[]
  /** Author id. */
  authorId?: string
  /** ISO datetime bounds on `occurredAt`. */
  before?: string
  after?: string
}

/**
 * The searchable text of a row: the ARTIFACT's own text — its ref (url /
 * attachment id / memo id) plus whatever the joined detail carries (a link's
 * title/url, an attachment's filename, a memo/task title, a thread's name).
 *
 * Deliberately NOT the snippet. The snippet is the source message's first line,
 * which every artifact of that message shares, so including it made one message
 * carrying five links match all five for a term naming only one — the filter
 * looked broken because only the true match highlighted. Mirrors the endpoint's
 * predicate; the two must agree or phase 2 widens into rows phase 1 excluded.
 */
export function contextRowText(row: CachedStreamContextItem): string {
  const detail = row.detail as unknown as Record<string, unknown>
  const parts = [row.refId]
  for (const field of ["url", "title", "siteName", "description", "filename", "giphyTitle", "name", "statusNote"]) {
    const value = detail?.[field]
    if (typeof value === "string") parts.push(value)
  }
  return parts.join(" ").toLowerCase()
}

/**
 * Phase 1 of the panel's search: the same narrowing the endpoint applies, run
 * over the IDB window so typing renders instantly. The server phase then widens
 * the set beyond what's cached.
 */
export function filterContextRows(
  rows: readonly CachedStreamContextItem[],
  filters: ContextRowFilters
): CachedStreamContextItem[] {
  const terms = (filters.terms ?? []).map((t) => t.toLowerCase()).filter(Boolean)
  return rows.filter((row) => {
    if (filters.category && row.category !== filters.category) return false
    if (filters.authorId && row.authorId !== filters.authorId) return false
    if (filters.before && row.occurredAt >= filters.before) return false
    if (filters.after && row.occurredAt < filters.after) return false
    if (terms.length > 0) {
      const text = contextRowText(row)
      if (!terms.every((term) => text.includes(term))) return false
    }
    return true
  })
}

/**
 * One row per `groupRef`, mirroring the endpoint's
 * `ROW_NUMBER() OVER (PARTITION BY category, group_key) … WHERE rn = 1`. IDB
 * holds every occurrence (locally derived rows, and every row an occurrence
 * fetch seeded), so the read side must collapse or an expanded group's members
 * re-enter the feed as top-level rows. The newest member represents the group;
 * its count is the larger of the server's and what's cached, so a partially
 * cached artifact never under-reports.
 */
export function collapseContextRows(rows: readonly CachedStreamContextItem[]): CachedStreamContextItem[] {
  const groups = new Map<string, { row: CachedStreamContextItem; count: number }>()
  for (const row of rows) {
    const group = groups.get(row.groupRef)
    if (!group) {
      groups.set(row.groupRef, { row, count: 1 })
      continue
    }
    group.count += 1
    if (row.occurredAt > group.row.occurredAt) group.row = row
  }
  return [...groups.values()].map(({ row, count }) =>
    count > row.occurrenceCount ? { ...row, occurrenceCount: count } : row
  )
}

/** Per-category counts over an already-filtered set, for the fallback chips. */
export function countByCategory(rows: readonly CachedStreamContextItem[]): Record<ContextCategory, number> {
  const counts = Object.fromEntries(CONTEXT_CATEGORIES.map((c) => [c, 0])) as Record<ContextCategory, number>
  for (const row of rows) counts[row.category] += 1
  return counts
}
