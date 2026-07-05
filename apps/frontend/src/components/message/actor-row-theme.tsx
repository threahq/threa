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
   * Per-actor row accent — a subtle left-to-right tint + inset left stripe, applied
   * to the full-bleed message row (the row breaks out to its surface's edges so the
   * stripe sits flush at the edge and the tint fills to the sides, matching the
   * stream timeline). Empty string = no accent (plain user rows). Used identically
   * by the timeline (`MessageEvent`) and the board/panel (`MessageItem`).
   */
  rowAccent: string
  /** Color class applied to the author-name element. Empty = inherit. */
  nameClassName: string
  /** Optional inline pill rendered in the header row after the author name. */
  badge: ReactNode | null
}

export const ACTOR_ROW_THEME: Record<AuthorType, ActorRowTheme> = {
  user: {
    rowAccent: "",
    nameClassName: "",
    badge: null,
  },
  persona: {
    rowAccent: "bg-gradient-to-r from-primary/[0.06] to-transparent shadow-[inset_3px_0_0_hsl(var(--primary))]",
    nameClassName: "text-primary",
    badge: null,
  },
  bot: {
    rowAccent: "bg-gradient-to-r from-emerald-500/[0.06] to-transparent shadow-[inset_3px_0_0_hsl(152_69%_41%)]",
    nameClassName: "text-emerald-600",
    badge: <span className="text-[10px] text-emerald-600/70 font-medium cursor-default">BOT</span>,
  },
  system: {
    rowAccent: "bg-gradient-to-r from-blue-500/[0.04] to-transparent shadow-[inset_3px_0_0_hsl(210_100%_55%)]",
    nameClassName: "text-blue-500",
    badge: null,
  },
}

/** The row theme for an actor type, defaulting to the plain `user` treatment. */
export function actorRowTheme(actorType: AuthorType | null | undefined): ActorRowTheme {
  return ACTOR_ROW_THEME[actorType ?? "user"]
}
