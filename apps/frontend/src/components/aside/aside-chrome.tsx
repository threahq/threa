import { Lock } from "lucide-react"
import { StreamTypes } from "@threa/types"
import { STREAM_ICONS } from "@/lib/streams"
import { cn } from "@/lib/utils"

export const AsideGlyph = STREAM_ICONS[StreamTypes.ASIDE]

/**
 * A pane in the aside — the conversation, the drafts, the host being read.
 * Card, not slab: the surfaces sit on a recessed stage with a gutter between
 * them, so each one reads as a separate thing you can work in.
 */
export const ASIDE_PANE = "flex min-h-0 flex-col overflow-hidden rounded-xl border bg-card"

/** A pane's own head strip: what this pane is, plus its controls. */
export const ASIDE_PANE_HEAD =
  "flex h-9 shrink-0 items-center gap-2 border-b border-border/70 px-3 text-[11.5px] text-muted-foreground"

/** Counts, ages, "read only" — the quiet mono register the sketch uses for state. */
export const ASIDE_META = "font-mono text-[10px] leading-none text-muted-foreground/80"

/** Section labels ("DRAFT"): mono, uppercase, tracked out. */
export const ASIDE_LABEL =
  "font-mono text-[10px] font-medium uppercase leading-none tracking-[0.11em] text-muted-foreground/80"

/**
 * Who can see this: nobody else, ever. Stated where the surface is read rather
 * than only where it was created, because an aside looks like every other
 * stream once it is open.
 */
export function AsidePrivateBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-1 rounded-full border border-primary/40 bg-primary/[0.07] px-2 py-0.5 text-[10.5px] font-medium text-primary",
        className
      )}
    >
      <Lock className="h-2.5 w-2.5" aria-hidden />
      Private
    </span>
  )
}
