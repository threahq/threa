import { Tag } from "lucide-react"
import { cn } from "@/lib/utils"
import { badgeVariants } from "@/components/ui/badge"
import { hexToRgba } from "@/lib/labels"

/**
 * Minimal shape a chip needs to render a label. `CachedLabel` / `Label` satisfy
 * it structurally, so callers can pass either without mapping.
 */
export interface LabelChipLabel {
  color: string
  emoji: string | null
  name: string
}

/**
 * A label's mark: its emoji on a faintly tinted disc, or — when the label has
 * no emoji — a `fallback` in the authored color (a solid dot for chips, a tag
 * glyph for catalog rows). Size/extra styles come via `className`. Used
 * standalone (collapsed surfaces) and as the chip's leading element.
 */
export function LabelGlyph({
  label,
  className,
  fallback = "dot",
}: {
  label: LabelChipLabel
  className?: string
  fallback?: "dot" | "tag"
}) {
  // One tinted-disc box for every case (emoji / tag / dot) so marks share a
  // footprint and shape — matching the label swatch language elsewhere. The
  // no-emoji case centers a small solid dot in the authored color.
  const mark =
    label.emoji ??
    (fallback === "tag" ? (
      <Tag className="h-3 w-3" />
    ) : (
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: label.color }} />
    ))
  return (
    <span
      className={cn("flex h-4 w-4 shrink-0 items-center justify-center rounded text-[11px] leading-none", className)}
      style={{ backgroundColor: hexToRgba(label.color, 0.15), color: label.color }}
      aria-hidden
    >
      {mark}
    </span>
  )
}

/**
 * Shared tinted label chip: the authored color tints the background and border,
 * the emoji (or a solid color dot) leads, and the name renders in ink. The one
 * visual language for labels across the sidebar label-section header and the
 * stream top-bar stack. Composes the Shadcn `badgeVariants` pill (INV-14) and
 * layers per-label authored color on top — no global accent tokens (DESIGN.md
 * §2.2, like trace hues).
 */
export function LabelChip({ label, className }: { label: LabelChipLabel; className?: string }) {
  return (
    <span
      className={cn(badgeVariants({ variant: "outline" }), "max-w-full gap-1.5 font-medium", className)}
      style={{ backgroundColor: hexToRgba(label.color, 0.12), borderColor: hexToRgba(label.color, 0.3) }}
    >
      <LabelGlyph label={label} />
      <span className="truncate">{label.name}</span>
    </span>
  )
}
