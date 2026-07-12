import { BOARD_LENSES } from "@threa/types"
import { BOARD_FILTER_PARAMS, BOARD_SCOPE_PARAM, parseIdListParam } from "@/components/board/board-filter-params"

const STORAGE_PREFIX = "threa-last-location"
const LEGACY_STREAM_PREFIX = "threa-last-stream"

export type LastLocationSurface = "stream" | "board"

export interface LastLocationBoard {
  lens: string | null
  search: string
}

export interface LastLocation {
  surface: LastLocationSurface
  streamId: string | null
  board: LastLocationBoard | null
}

function key(userId: string, workspaceId: string): string {
  return `${STORAGE_PREFIX}:${userId}:${workspaceId}`
}

function legacyKey(userId: string, workspaceId: string): string {
  return `${LEGACY_STREAM_PREFIX}:${userId}:${workspaceId}`
}

/**
 * Keep only the board's own URL vocabulary in a persisted search string: the
 * six filter axes + `archived` ({@link BOARD_FILTER_PARAMS}). `?panel=` and
 * `?m=` are deliberately dropped — a cold start into a months-old panel is a
 * worse default than the filtered feed. Returns a leading-`?` string (or "").
 */
export function sanitizeBoardSearch(search: string): string {
  const src = new URLSearchParams(search)
  const out = new URLSearchParams()
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
    if (b.lens !== null && typeof b.lens !== "string") return null
    if (typeof b.search !== "string") return null
    board = { lens: (b.lens as string | null) ?? null, search: b.search }
  }

  return {
    surface: record.surface,
    streamId: (record.streamId as string | null) ?? null,
    board,
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
      board: location.board ? { lens: location.board.lens, search: sanitizeBoardSearch(location.board.search) } : null,
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
 * Build the explicit board URL to restore from a persisted board state.
 * An unknown lens degrades to the bare `/board` (the home lens resolves there),
 * and stale stream ids are swept from the `in` axis. Writing the explicit URL
 * lets the board's own home-redirect run cleanly for a bare-board record.
 */
export function buildBoardHref(
  workspaceId: string,
  board: LastLocationBoard,
  knownStreamIds: readonly string[]
): string {
  const lens = board.lens && (BOARD_LENSES as readonly string[]).includes(board.lens) ? board.lens : null
  const pathname = lens ? `/w/${workspaceId}/board/${lens}` : `/w/${workspaceId}/board`
  const search = sweepStaleStreamScope(sanitizeBoardSearch(board.search), knownStreamIds)
  return `${pathname}${search}`
}
