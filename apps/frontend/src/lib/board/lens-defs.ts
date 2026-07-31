import type { LucideIcon } from "lucide-react"
import { BookMarked, LayoutGrid, User } from "lucide-react"
import { type BoardLens } from "@threa/types"

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
  decisions: {
    value: "decisions",
    label: "Decisions",
    description: "Settled — captured as a memo",
    icon: BookMarked,
  },
  mine: {
    value: "mine",
    label: "Mine",
    description: "Conversations you're in or mentioned in",
    icon: User,
  },
}
