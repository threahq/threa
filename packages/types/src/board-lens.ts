import { BOARD_LENS_MAX_COMPLETENESS, BOARD_LENS_STALE_HOURS, type BoardLens } from "./constants"
import type { BoardPost } from "./domain"

/**
 * Whether a board post belongs on a lens — the read-side authority the board
 * card filters the live IDB feed with, kept in lockstep with the backend's
 * seed/pagination SQL (`findByWorkspaceForViewer`) so a card can't seed onto a
 * lens the client then hides, or vice versa. Both sides read the same signals
 * and the same thresholds (`BOARD_LENS_*`); this is the JS half, the WHERE
 * clause is the SQL half.
 *
 *  - `active` — everything, by recency (the default wall).
 *  - `needs-resolution` — explicitly stalled, or gone quiet (≥ stale hours) while
 *    still incomplete (< max completeness). Loose ends.
 *  - `decisions` — produced a captured memo (`hasCapturedMemo`). What got settled.
 *
 * `nowMs` is passed in (not read via `Date.now()`) so the filter is pure and
 * testable; callers pass the current time at render.
 */
export function matchesBoardLens(post: BoardPost, lens: BoardLens, nowMs: number): boolean {
  switch (lens) {
    case "active":
      return true
    case "decisions":
      return post.hasCapturedMemo === true
    case "needs-resolution": {
      const { status, lastActivityAt, completenessScore } = post.conversation
      if (status === "stalled") return true
      const hoursIdle = (nowMs - Date.parse(lastActivityAt)) / 3_600_000
      return hoursIdle >= BOARD_LENS_STALE_HOURS && completenessScore < BOARD_LENS_MAX_COMPLETENESS
    }
  }
}
