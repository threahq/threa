import {
  BOARD_FILTER_PARAMS,
  BOARD_LENS_PARAM,
  BOARD_SCOPE_PARAM,
  parseIdListParam,
  parseLensParam,
} from "@/components/board/board-filter-params"

const STORAGE_PREFIX = "threa-last-location"
const LEGACY_STREAM_PREFIX = "threa-last-stream"

export type LastLocationSurface = "stream" | "board"

export interface LastLocationBoard {
  search: string
}

/** The exact in-workspace URL last seen, for verbatim restore after a crash or
 *  OS kill of the backgrounded PWA. `at` is bumped on backgrounding, so it
 *  measures time-since-last-seen, not time-since-last-navigation. */
export interface LastLocationExact {
  path: string
  at: number
}

export interface LastLocation {
  surface: LastLocationSurface
  streamId: string | null
  board: LastLocationBoard | null
  exact?: LastLocationExact
}

/**
 * How recent the exact record must be to restore verbatim. Within the window a
 * relaunch is a crash-restart continuation (the Firefox round-trip that got the
 * PWA killed), so the viewer gets back exactly what they were looking at —
 * including `?panel=`/`?m=` and non-stream pages. Beyond it, the sanitized
 * stream/board arms apply: a cold start into a months-old panel is a worse
 * default than the filtered feed.
 */
export const EXACT_RESTORE_WINDOW_MS = 30 * 60 * 1000

function key(userId: string, workspaceId: string): string {
  return `${STORAGE_PREFIX}:${userId}:${workspaceId}`
}

function legacyKey(userId: string, workspaceId: string): string {
  return `${LEGACY_STREAM_PREFIX}:${userId}:${workspaceId}`
}

/**
 * Keep only the board's own URL vocabulary in a persisted search string: the
 * lens plus the filter axes + `archived` ({@link BOARD_FILTER_PARAMS}). `?panel=`
 * and `?m=` are deliberately dropped — a cold start into a months-old panel is a
 * worse default than the filtered feed. Returns a leading-`?` string (or "" for
 * a record captured on the bare entry alias — restoring that resolves the
 * viewer's home again, which is what landing there meant).
 */
export function sanitizeBoardSearch(search: string): string {
  const src = new URLSearchParams(search)
  const out = new URLSearchParams()
  const lens = src.get(BOARD_LENS_PARAM)
  if (lens !== null) out.set(BOARD_LENS_PARAM, parseLensParam(lens))
  for (const param of BOARD_FILTER_PARAMS) {
    for (const value of src.getAll(param)) out.append(param, value)
  }
  const query = out.toString()
  return query ? `?${query}` : ""
}

function parseRecord(raw: string): LastLocation | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null
  const record = parsed as Record<string, unknown>
  if (record.surface !== "stream" && record.surface !== "board") return null
  if (record.streamId !== null && typeof record.streamId !== "string") return null

  let board: LastLocationBoard | null = null
  if (record.board !== null && record.board !== undefined) {
    if (typeof record.board !== "object") return null
    const b = record.board as Record<string, unknown>
    if (typeof b.search !== "string") return null
    board = { search: b.search }
  }

  let exact: LastLocationExact | undefined
  if (record.exact !== null && record.exact !== undefined && typeof record.exact === "object") {
    const e = record.exact as Record<string, unknown>
    if (typeof e.path === "string" && typeof e.at === "number") {
      exact = { path: e.path, at: e.at }
    }
  }

  return {
    surface: record.surface,
    streamId: (record.streamId as string | null) ?? null,
    board,
    ...(exact ? { exact } : {}),
  }
}

/**
 * Read the persisted last location. Falls back to the legacy
 * `threa-last-stream` key (as a `stream` surface) when no new-format record
 * exists; the legacy key is deleted the next time a record is written.
 */
export function getLastLocation(userId: string, workspaceId: string): LastLocation | null {
  try {
    const raw = localStorage.getItem(key(userId, workspaceId))
    const record = raw ? parseRecord(raw) : null
    if (record) return record

    const legacy = localStorage.getItem(legacyKey(userId, workspaceId))
    if (legacy) return { surface: "stream", streamId: legacy, board: null }
    return null
  } catch {
    return null
  }
}

export function setLastLocation(userId: string, workspaceId: string, location: LastLocation): void {
  try {
    const record: LastLocation = {
      surface: location.surface,
      streamId: location.streamId,
      board: location.board ? { search: sanitizeBoardSearch(location.board.search) } : null,
      ...(location.exact ? { exact: location.exact } : {}),
    }
    localStorage.setItem(key(userId, workspaceId), JSON.stringify(record))
    localStorage.removeItem(legacyKey(userId, workspaceId))
  } catch {
    // Storage unavailable
  }
}

export function clearLastLocation(userId: string, workspaceId: string): void {
  try {
    localStorage.removeItem(key(userId, workspaceId))
    localStorage.removeItem(legacyKey(userId, workspaceId))
  } catch {
    // Storage unavailable
  }
}

/** Drop stream ids no longer in the workspace from the `in` (focus) axis only;
 *  other params and their order are preserved. Skipped when no known ids are
 *  available (cache not yet hydrated) so a cold read can't strip a valid scope.
 *
 *  Only `in` is swept: it matches root-only (`matchesScope`), so its ids are
 *  channel-level and reliably in the streams cache — a stale one means an empty
 *  board, worth pruning. `not-in` matches anchor-OR-root (`matchesExcludedStreams`),
 *  so it can legitimately carry a thread's own (anchor) id, which is lazily
 *  hydrated and likely absent at cold start; sweeping it would silently drop a
 *  valid exclusion. The board tolerates unknown exclude ids server-side, so
 *  leaving `not-in` untouched is both safe and correct. */
function sweepStaleStreamScope(search: string, knownStreamIds: readonly string[]): string {
  if (knownStreamIds.length === 0) return search
  const params = new URLSearchParams(search)
  const known = new Set(knownStreamIds)
  const raw = params.get(BOARD_SCOPE_PARAM)
  if (raw != null) {
    const kept = parseIdListParam(raw).filter((id) => known.has(id))
    if (kept.length > 0) params.set(BOARD_SCOPE_PARAM, kept.join(","))
    else params.delete(BOARD_SCOPE_PARAM)
  }
  const query = params.toString()
  return query ? `?${query}` : ""
}

/**
 * Build the board URL to restore from a persisted board state: `/board` plus the
 * sanitized query (lens + filter axes), with stale stream ids swept from the
 * `in` axis. An empty stored search restores the bare entry alias, which
 * re-resolves the viewer's home — the meaning of having been there.
 */
/**
 * The exact path to restore verbatim, or null when the record is missing,
 * stale (older than {@link EXACT_RESTORE_WINDOW_MS}), for another workspace, or
 * the workspace index itself (restoring the index would loop the redirect).
 */
export function freshExactPath(record: LastLocation | null, workspaceId: string, now: number): string | null {
  const exact = record?.exact
  if (!exact) return null
  if (now - exact.at > EXACT_RESTORE_WINDOW_MS) return null
  const prefix = `/w/${workspaceId}`
  if (!exact.path.startsWith(`${prefix}/`)) return null
  const rest = exact.path.slice(prefix.length)
  if (rest === "/" || rest.startsWith("/?")) return null
  return exact.path
}

export function buildBoardHref(
  workspaceId: string,
  board: LastLocationBoard,
  knownStreamIds: readonly string[]
): string {
  const search = sweepStaleStreamScope(sanitizeBoardSearch(board.search), knownStreamIds)
  return `/w/${workspaceId}/board${search}`
}
