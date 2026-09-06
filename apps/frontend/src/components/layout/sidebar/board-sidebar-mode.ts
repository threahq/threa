import { StreamTypes, type BoardLens, type BoardScopeStreamType, type StreamType } from "@threahq/types"
import type { BoardStreamStats } from "@/hooks/use-board-sidebar-stats"

/**
 * A row's board scope id: the board scopes root streams, so a thread focuses its
 * root, not itself; every other stream focuses itself. Shared by the stream row
 * (its focus/toggle target) and the section-header "Scope all" so the two can't
 * drift (INV-35).
 */
export function boardScopeStreamId(stream: { type: StreamType; id: string; rootStreamId?: string | null }): string {
  return stream.type === StreamTypes.THREAD ? (stream.rootStreamId ?? stream.id) : stream.id
}

/**
 * Whether a workspace-relative location is the board surface. The whole board
 * view is query state (`?lens=` + filter axes), so the pathname is exactly
 * `/w/:workspaceId/board` — no lens segment exists anymore.
 */
export function isBoardPath(pathname: string): boolean {
  return /^\/w\/[^/]+\/board$/.test(pathname)
}

/**
 * Board-mode descriptor threaded from the sidebar orchestrator into every stream
 * row. Present only on
 * `/board` with the flag on; `null` everywhere else, and every board branch in a
 * row is gated on it so chats mode renders byte-identically. Built once at the
 * list level (not per row) so the mute mutations, muted set, URL callbacks, and
 * the single topic-stats aggregation are shared rather than re-derived per row.
 */
export interface SidebarBoardMode {
  workspaceId: string
  /** Included stream scope (`?in=`) — root ids currently focusing the board. */
  includedStreamIds: ReadonlySet<string>
  /** Excluded stream scope (`?not-in=`) — vetoed root ids. */
  excludedStreamIds: ReadonlySet<string>
  /** Root streams the viewer muted from the board (rendered dimmed, never hidden). */
  mutedStreamIds: ReadonlySet<string>
  /** Focus href for a row's `<Link>` — replaces the scope with this stream (or
   *  clears it when the stream is already the sole include). A real navigation
   *  (INV-40), so back/forward reproduce the scope. */
  focusHref: (streamId: string) => string
  /** Additive include toggle (cmd/ctrl-click, tile checkbox, "Add to filter"). */
  applyInclude: (streamId: string) => void
  /** Additive exclude toggle ("Exclude from board" / "Include again"). */
  applyExclude: (streamId: string) => void
  /** Board URL that scopes `?in=` to an entire section's streams at once (the
   *  Unread / custom-section header "Scope all"). Ids are root scope ids; the
   *  builder dedupes + caps at `MAX_BOARD_SCOPE_STREAMS`. A real navigation
   *  (INV-40), so back/forward reproduce the scope. */
  scopeAllHref: (streamIds: string[]) => string
  /** Board URL that focuses the label axis on one label (the label-section
   *  header's open affordance in board mode → `?label=<id>` instead of the label
   *  page). */
  labelFocusHref: (labelId: string) => string
  /** Board URL that focuses the type axis on one root-stream type (a type
   *  section's — Channels/DMs/Scratchpads — open affordance → `?is=<type>`). */
  typeFocusHref: (type: BoardScopeStreamType) => string
  /** Board URL that narrows to unread conversations (the Unread section's open
   *  affordance → `?unread=true`). Live, not a snapshot — unlike `scopeAllHref`,
   *  it keeps matching as things get read/unread instead of freezing the ids
   *  that were unread at click time. */
  unreadFocusHref: () => string
  /** Board URL with ONE filter axis dropped — the un-toggle behind an already-
   *  active section-header filter, so the same control turns it back off. Takes a
   *  `board-filter-params` param name. */
  clearAxisHref: (param: string) => string
  /** Mute / unmute a root stream on the board. */
  setMuted: (streamId: string, mute: boolean) => void
  /** Per-root-stream topic tally for the row's board-mode preview line. `null`
   *  until the single stats aggregation resolves; the row renders no line then.
   *  A resolved-but-uncounted stream reads back {@link ZERO_BOARD_STREAM_STATS}. */
  statsForStream: (streamId: string) => BoardStreamStats | null
  /** Per-lens workspace totals for the Lenses rows, or `null` until stats resolve. */
  lensTotals: Record<BoardLens, number> | null
}
