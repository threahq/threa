import { BOARD_LENSES, DEFAULT_BOARD_LENS, type BoardLens } from "./constants"
import type { BoardPost } from "./domain"

/**
 * The single degrade authority for lens values arriving from outside the live
 * set — retired values (`decisions`), stale prefs, saved rows, old bundles.
 * Every write path (board-views, user-preferences) and read boundary maps
 * through this so a retired lens always means "widest live lens", never a 400.
 */
export function degradeBoardLens(value: unknown): BoardLens {
  return typeof value === "string" && (BOARD_LENSES as readonly string[]).includes(value)
    ? (value as BoardLens)
    : DEFAULT_BOARD_LENS
}

/**
 * Whether a board post belongs on a lens — the read-side authority the board
 * card filters the live IDB feed with, kept in lockstep with the backend's
 * seed/pagination SQL (`findByWorkspaceForViewer`) so a card can't seed onto a
 * lens the client then hides, or vice versa.
 *
 *  - `all` — everything, by recency. The default home; never hides anything.
 *  - `mine` — the viewer authored/participates in it or was `@`-mentioned
 *    (`isMine`, precomputed server-side). For you.
 *
 * A lens value outside the list behaves as `all`: saved `board_views.base_lens`
 * rows and persisted last-locations still hold retired lens values (`decisions`),
 * and a stale filter must degrade to showing everything, never hide rows or
 * throw. Mirrors `parseLensParam`'s degrade.
 */
export function matchesBoardLens(post: BoardPost, lens: BoardLens): boolean {
  switch (lens) {
    case "mine":
      return post.isMine === true
    default:
      return true
  }
}
