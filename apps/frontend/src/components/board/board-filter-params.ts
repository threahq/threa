import { BOARD_SCOPE_STREAM_TYPES, type BoardScopeStreamType } from "@threa/types"

/**
 * The board's URL filter vocabulary — one source of truth (INV-33) for every
 * writer/reader of the board's query params: the page (parse), the filter bar
 * (toggles), and saved views (expand a bookmark back into a URL).
 *
 * Six params, three dimensions × include/exclude. `in`/`is` follow the search
 * syntax's vocabulary; the `not-` prefix is the negation. Include narrows,
 * exclude vetoes; when both name the same id the veto wins (the backend ANDs
 * the two conditions).
 */

/** Stream scope (`?in=<id>,<id>` — root-stream ids). */
export const BOARD_SCOPE_PARAM = "in"

/** Stream veto (`?not-in=` — matches by anchor OR effective root, so a thread
 *  id excludes just that thread while a root id drops everything under it). */
export const BOARD_EXCLUDE_SCOPE_PARAM = "not-in"

/** Root-stream TYPE scope (`?is=dm,channel`). */
export const BOARD_TYPE_PARAM = "is"

/** Root-stream TYPE veto (`?not-is=`). */
export const BOARD_EXCLUDE_TYPE_PARAM = "not-is"

/** Label scope (`?label=<id>,<id>` — the viewer's own labels; a conversation
 *  matches when its anchor or root stream carries one). */
export const BOARD_LABEL_PARAM = "label"

/** Label veto (`?not-label=`). */
export const BOARD_EXCLUDE_LABEL_PARAM = "not-label"

/** Archived opt-in (`?archived=true`). Unlike the other axes this BROADENS the
 *  feed — including cards under archived streams instead of the default hide —
 *  so its on-value is `"true"`, not an id list. */
export const BOARD_ARCHIVED_PARAM = "archived"

/** The `?archived=` value that opts into archived cards (matches the backend
 *  `showArchived` flag). */
export const BOARD_ARCHIVED_ON = "true"

/** Every board filter param, for clear-all sweeps. */
export const BOARD_FILTER_PARAMS = [
  BOARD_SCOPE_PARAM,
  BOARD_EXCLUDE_SCOPE_PARAM,
  BOARD_TYPE_PARAM,
  BOARD_EXCLUDE_TYPE_PARAM,
  BOARD_LABEL_PARAM,
  BOARD_EXCLUDE_LABEL_PARAM,
  BOARD_ARCHIVED_PARAM,
] as const

/**
 * The search string for a link back to the unfiltered board home: the current
 * query minus the filter params. Every "clear the filters" affordance (the
 * bar's Clear filters, the empty state's Show everything, the
 * post-from-filtered-view navigation) must route through this so clearing
 * filters never has the side effect of dropping unrelated URL state — an open
 * `?panel=` must survive.
 */
export function boardHomeSearch(search: string): string {
  const params = new URLSearchParams(search)
  for (const param of BOARD_FILTER_PARAMS) params.delete(param)
  const query = params.toString()
  return query ? `?${query}` : ""
}

/** Parse a comma-separated id list param: trimmed, deduped, order-preserving. */
export function parseIdListParam(value: string | null): string[] {
  if (!value) return []
  return Array.from(
    new Set(
      value
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
    )
  )
}

/**
 * Toggle an id's INCLUDE membership within one dimension. Include and exclude
 * are mutually exclusive per id — including an excluded id moves it across, so
 * a picker row can never be both.
 */
export function toggleInclude<T>(id: T, include: T[], exclude: T[]): { include: T[]; exclude: T[] } {
  if (include.includes(id)) return { include: include.filter((x) => x !== id), exclude }
  return { include: [...include, id], exclude: exclude.filter((x) => x !== id) }
}

/** Toggle an id's EXCLUDE membership; the mirror of {@link toggleInclude}. */
export function toggleExclude<T>(id: T, include: T[], exclude: T[]): { include: T[]; exclude: T[] } {
  if (exclude.includes(id)) return { include, exclude: exclude.filter((x) => x !== id) }
  return { include: include.filter((x) => x !== id), exclude: [...exclude, id] }
}

/** Parse a stream-type list param, dropping tokens outside the board's root
 *  grains — a hand-built URL degrades instead of 400ing the fetch. */
export function parseTypeListParam(value: string | null): BoardScopeStreamType[] {
  if (!value) return []
  return Array.from(
    new Set(
      value
        .split(",")
        .map((t) => t.trim())
        .filter((t): t is BoardScopeStreamType => (BOARD_SCOPE_STREAM_TYPES as readonly string[]).includes(t))
    )
  )
}
