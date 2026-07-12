import { BOARD_SCOPE_STREAM_TYPES, MAX_BOARD_SCOPE_STREAMS, type BoardScopeStreamType } from "@threa/types"

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

/** Unread opt-in (`?unread=true`) — narrows to conversations on a currently
 *  unread (and unmuted) root stream. Client-resolved (mirrors the sidebar's own
 *  Unread section membership), so it stays live as things get read/unread
 *  instead of snapshotting ids the way the section header's old "Scope all" did. */
export const BOARD_UNREAD_PARAM = "unread"

/** The `?unread=` value that opts into the unread-only narrowing. */
export const BOARD_UNREAD_ON = "true"

/** Every board filter param, for clear-all sweeps. */
export const BOARD_FILTER_PARAMS = [
  BOARD_SCOPE_PARAM,
  BOARD_EXCLUDE_SCOPE_PARAM,
  BOARD_TYPE_PARAM,
  BOARD_EXCLUDE_TYPE_PARAM,
  BOARD_LABEL_PARAM,
  BOARD_EXCLUDE_LABEL_PARAM,
  BOARD_ARCHIVED_PARAM,
  BOARD_UNREAD_PARAM,
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

/** Serialize a URLSearchParams back to a leading-`?` search string (or ""). */
function toSearch(params: URLSearchParams): string {
  const query = params.toString()
  return query ? `?${query}` : ""
}

/** Write an id list to a param, deleting the param when the list is empty. */
function writeIdList(params: URLSearchParams, param: string, ids: string[]): void {
  if (ids.length > 0) params.set(param, ids.join(","))
  else params.delete(param)
}

/** True when `?in=` is exactly this one stream — the focus-click clears the scope
 *  instead of re-focusing when you click the stream you're already focused on. */
export function isSoleInclude(search: string, streamId: string): boolean {
  const ids = parseIdListParam(new URLSearchParams(search).get(BOARD_SCOPE_PARAM))
  return ids.length === 1 && ids[0] === streamId
}

/**
 * The board-mode row verb (board-centered-sidebar-exploration.md § "Click
 * model"): FOCUS the board on one stream. Replaces the `?in=` scope with just
 * this id and drops it from `?not-in=`, leaving every other axis (types, labels,
 * archived, an open `?panel=`) untouched — only the stream axes change. Clicking
 * the stream that is already the sole include clears `?in=` instead (a second
 * focus-click on the focused stream un-focuses). Returns the search string; the
 * caller pairs it with the current board pathname so the lens survives.
 */
export function focusScopeSearch(search: string, streamId: string): string {
  const params = new URLSearchParams(search)
  if (isSoleInclude(search, streamId)) {
    params.delete(BOARD_SCOPE_PARAM)
    return toSearch(params)
  }
  writeIdList(params, BOARD_SCOPE_PARAM, [streamId])
  const excluded = parseIdListParam(params.get(BOARD_EXCLUDE_SCOPE_PARAM)).filter((id) => id !== streamId)
  writeIdList(params, BOARD_EXCLUDE_SCOPE_PARAM, excluded)
  return toSearch(params)
}

/** Additive include toggle over the stream axis (cmd/ctrl-click, the tile
 *  checkbox, the "Add to filter" verb) — the accumulate model, distinct from
 *  {@link focusScopeSearch}'s replace. Mirrors {@link toggleInclude} but rewrites
 *  the URL directly, and no-ops past {@link MAX_BOARD_SCOPE_STREAMS} so it can't
 *  build a URL the board would silently truncate. */
export function toggleIncludeSearch(search: string, streamId: string): string {
  const params = new URLSearchParams(search)
  const include = parseIdListParam(params.get(BOARD_SCOPE_PARAM))
  const exclude = parseIdListParam(params.get(BOARD_EXCLUDE_SCOPE_PARAM))
  if (!include.includes(streamId) && include.length >= MAX_BOARD_SCOPE_STREAMS) return toSearch(params)
  const next = toggleInclude(streamId, include, exclude)
  writeIdList(params, BOARD_SCOPE_PARAM, next.include)
  writeIdList(params, BOARD_EXCLUDE_SCOPE_PARAM, next.exclude)
  return toSearch(params)
}

/** Additive exclude toggle over the stream axis (the "Exclude from board" verb).
 *  Mirror of {@link toggleIncludeSearch}. */
export function toggleExcludeSearch(search: string, streamId: string): string {
  const params = new URLSearchParams(search)
  const include = parseIdListParam(params.get(BOARD_SCOPE_PARAM))
  const exclude = parseIdListParam(params.get(BOARD_EXCLUDE_SCOPE_PARAM))
  if (!exclude.includes(streamId) && exclude.length >= MAX_BOARD_SCOPE_STREAMS) return toSearch(params)
  const next = toggleExclude(streamId, include, exclude)
  writeIdList(params, BOARD_SCOPE_PARAM, next.include)
  writeIdList(params, BOARD_EXCLUDE_SCOPE_PARAM, next.exclude)
  return toSearch(params)
}

/**
 * The section-header "Scope all" verb (Unread / custom-section headers, board
 * mode): replace the whole stream scope with every stream in one section at once.
 * Generalizes {@link focusScopeSearch} from one id to a list — sets `?in=` to the
 * ids (deduped, capped at {@link MAX_BOARD_SCOPE_STREAMS} keep-first) and drops
 * those ids from `?not-in=`, leaving every other axis (types, labels, archived,
 * the lens-carried params) untouched. The caller root-resolves threads to their
 * root before passing ids, since the board scopes root streams.
 */
export function scopeAllSearch(search: string, streamIds: string[]): string {
  const params = new URLSearchParams(search)
  const ids = Array.from(new Set(streamIds.filter(Boolean))).slice(0, MAX_BOARD_SCOPE_STREAMS)
  writeIdList(params, BOARD_SCOPE_PARAM, ids)
  const included = new Set(ids)
  const excluded = parseIdListParam(params.get(BOARD_EXCLUDE_SCOPE_PARAM)).filter((id) => !included.has(id))
  writeIdList(params, BOARD_EXCLUDE_SCOPE_PARAM, excluded)
  return toSearch(params)
}

/**
 * The board-mode label-section header verb: FOCUS the board's label axis on one
 * label (`?label=<id>`). Mirrors {@link focusScopeSearch} on the label axis —
 * replaces the label include list with just this id and drops it from
 * `?not-label`, leaving every other axis untouched. The board's label matching is
 * anchor-or-root and stays live as assignments change, so this beats expanding a
 * pinned label to stream ids (design doc § "Feature parity").
 */
export function labelFocusSearch(search: string, labelId: string): string {
  const params = new URLSearchParams(search)
  writeIdList(params, BOARD_LABEL_PARAM, [labelId])
  const excluded = parseIdListParam(params.get(BOARD_EXCLUDE_LABEL_PARAM)).filter((id) => id !== labelId)
  writeIdList(params, BOARD_EXCLUDE_LABEL_PARAM, excluded)
  return toSearch(params)
}

/**
 * The board-mode type-section header verb: FOCUS the board's type axis on one
 * root-stream type (`?is=<type>`). Mirrors {@link labelFocusSearch} on the type
 * axis — replaces the type include list with just this one and drops it from
 * `?not-is`, leaving every other axis untouched.
 */
export function typeFocusSearch(search: string, type: BoardScopeStreamType): string {
  const params = new URLSearchParams(search)
  writeIdList(params, BOARD_TYPE_PARAM, [type])
  const excluded = parseTypeListParam(params.get(BOARD_EXCLUDE_TYPE_PARAM)).filter((t) => t !== type)
  writeIdList(params, BOARD_EXCLUDE_TYPE_PARAM, excluded)
  return toSearch(params)
}

/**
 * The board-mode Unread-section header verb: FOCUS the board on unread
 * conversations (`?unread=true`), leaving every other axis untouched.
 */
export function unreadFocusSearch(search: string): string {
  const params = new URLSearchParams(search)
  params.set(BOARD_UNREAD_PARAM, BOARD_UNREAD_ON)
  return toSearch(params)
}

/** Remove one value from any single filter axis (a chip's X). Works for every
 *  id/type list param — the value is dropped, order and the other params kept. */
export function removeAxisValueSearch(search: string, param: string, value: string): string {
  const params = new URLSearchParams(search)
  const kept = parseIdListParam(params.get(param)).filter((v) => v !== value)
  writeIdList(params, param, kept)
  return toSearch(params)
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
