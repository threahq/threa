/**
 * Board-mode descriptor threaded from the sidebar orchestrator into every stream
 * row (board-centered-sidebar-exploration.md § "Click model"). Present only on
 * `/board` with the flag on; `null` everywhere else, and every board branch in a
 * row is gated on it so chats mode renders byte-identically. Built once at the
 * list level (not per row) so the mute mutations, muted set, and URL callbacks
 * are shared rather than re-derived per row.
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
  /** Mute / unmute a root stream on the board. */
  setMuted: (streamId: string, mute: boolean) => void
}
