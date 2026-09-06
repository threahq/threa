import type { LucideIcon } from "lucide-react"
import { LayoutGrid, User } from "lucide-react"
import { type BoardLens } from "@threahq/types"

export interface BoardLensDef {
  value: BoardLens
  label: string
  /** One-line answer to "what does this show?" — rendered under the label in the picker. */
  description: string
  icon: LucideIcon
}

/**
 * Display metadata per lens (label, one-line description, glyph). The single
 * source for lens copy (INV-33) — the board lens picker and the settings
 * "Board home" control both read from here. Order follows `BOARD_LENSES`.
 */
export const BOARD_LENS_DEFS: Record<BoardLens, BoardLensDef> = {
  all: { value: "all", label: "All", description: "Everything, newest activity first", icon: LayoutGrid },
  mine: {
    value: "mine",
    label: "Mine",
    description: "Conversations you're in or mentioned in",
    icon: User,
  },
}
