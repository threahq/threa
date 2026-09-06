import type { BoardScopeStreamType } from "@threahq/types"

/** Display labels per board root-stream grain (INV-33). Shared by the filter
 *  bar's type picker/chips and the board-mode sidebar chips so the two can't
 *  drift. Order follows `BOARD_SCOPE_STREAM_TYPES`. */
export const BOARD_STREAM_TYPE_LABELS: Record<BoardScopeStreamType, string> = {
  channel: "Channels",
  dm: "DMs",
  scratchpad: "Scratchpads",
  system: "System",
}
