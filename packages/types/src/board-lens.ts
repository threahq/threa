import type { BoardLens } from "./constants"
import type { BoardPost } from "./domain"

/**
 * Whether a board post belongs on a lens — the read-side authority the board
 * card filters the live IDB feed with, kept in lockstep with the backend's
 * seed/pagination SQL (`findByWorkspaceForViewer`) so a card can't seed onto a
 * lens the client then hides, or vice versa.
 *
 *  - `all` — everything, by recency. The default home; never hides anything.
 *  - `decisions` — produced a captured memo (`hasCapturedMemo`). What got settled.
 *  - `mine` — the viewer authored/participates in it or was `@`-mentioned
 *    (`isMine`, precomputed server-side like `hasCapturedMemo`). For you.
 *
 * A lens value outside the list behaves as `all`: saved `board_views.base_lens`
 * rows and persisted last-locations still hold retired lens values, and a stale
 * filter must degrade to showing everything, never hide rows or throw. Mirrors
 * `parseLensParam`'s degrade.
 */
export function matchesBoardLens(post: BoardPost, lens: BoardLens): boolean {
  switch (lens) {
    case "decisions":
      return post.hasCapturedMemo === true
    case "mine":
      return post.isMine === true
    default:
      return true
  }
}
