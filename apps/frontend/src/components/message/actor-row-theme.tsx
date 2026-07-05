import type { ReactNode } from "react"
import type { AuthorType } from "@threa/types"

/**
 * Per-actor-type row styling — the single source of truth for how a message from
 * each actor type looks across EVERY surface that renders a message: the stream
 * timeline (`MessageEvent`) and the board card / conversation panel
 * (`MessageItem`). Adding a new actor type is one entry here, applied everywhere
 * (INV-35) — no scattered `isPersona && … || isBot && …` chains, and no surface
 * that quietly renders agent/bot messages flat.
 */
export interface ActorRowTheme {
  /**
   * Timeline row accent — a gradient + inset stripe designed for edge-to-edge
   * stream rows on `bg-background`. Empty string = no accent. NOT used on the
   * board (it floats + reads muddy inside a padded card); see `cardAccent`.
   */
  rowAccent: string
  /**
   * Board / conversation-panel accent — a crisp rounded left bar + whisper tint on
   * the message CONTENT block, contained and aligned inside the padded card (no
   * floating stripe, no full-row gradient). Empty string = no accent.
   */
  cardAccent: string
  /** Color class applied to the author-name element. Empty = inherit. */
  nameClassName: string
  /** Optional inline pill rendered in the header row after the author name. */
  badge: ReactNode | null
}

export const ACTOR_ROW_THEME: Record<AuthorType, ActorRowTheme> = {
  user: {
    rowAccent: "",
    cardAccent: "",
    nameClassName: "",
    badge: null,
  },
  persona: {
    rowAccent: "bg-gradient-to-r from-primary/[0.06] to-transparent shadow-[inset_3px_0_0_hsl(var(--primary))]",
    cardAccent: "border-l-2 border-primary/50 bg-primary/[0.04] rounded-r-lg pl-2.5 py-1 -ml-0.5",
    nameClassName: "text-primary",
    badge: null,
  },
  bot: {
    rowAccent: "bg-gradient-to-r from-emerald-500/[0.06] to-transparent shadow-[inset_3px_0_0_hsl(152_69%_41%)]",
    cardAccent: "border-l-2 border-emerald-500/50 bg-emerald-500/[0.04] rounded-r-lg pl-2.5 py-1 -ml-0.5",
    nameClassName: "text-emerald-600",
    badge: <span className="text-[10px] text-emerald-600/70 font-medium cursor-default">BOT</span>,
  },
  system: {
    rowAccent: "bg-gradient-to-r from-blue-500/[0.04] to-transparent shadow-[inset_3px_0_0_hsl(210_100%_55%)]",
    cardAccent: "border-l-2 border-blue-500/50 bg-blue-500/[0.04] rounded-r-lg pl-2.5 py-1 -ml-0.5",
    nameClassName: "text-blue-500",
    badge: null,
  },
}

/** The row theme for an actor type, defaulting to the plain `user` treatment. */
export function actorRowTheme(actorType: AuthorType | null | undefined): ActorRowTheme {
  return ACTOR_ROW_THEME[actorType ?? "user"]
}
