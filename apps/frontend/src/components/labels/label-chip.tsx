import type { CSSProperties } from "react"
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
  style,
  fallback = "dot",
}: {
  label: LabelChipLabel
  className?: string
  style?: CSSProperties
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
      style={{ ...style, backgroundColor: hexToRgba(label.color, 0.15), color: label.color }}
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

const STACK_SIZES = {
  sm: { glyph: "h-3.5 w-3.5", px: 14, overlap: 3.5 },
  md: { glyph: "h-4 w-4", px: 16, overlap: 4 },
} as const
/** Clearance between a tucked glyph and the one in front of it. */
const CUT_GAP = 1.5
/** Space between glyphs once the stack is fanned out. */
const FAN_GAP = 2
/** LabelGlyph's `rounded` corner, so the cutout traces the front glyph's outline. */
const GLYPH_RADIUS = 4

/**
 * A mask that hides the part of a glyph sitting under its right-hand neighbour:
 * a rounded cutout tracing that neighbour's outline plus `CUT_GAP`. Tints never
 * blend and no surface color is assumed, so it reads the same on a hovered or
 * active row. The image is `travel` wider than the glyph so sliding it right as
 * the stack fans out carries the cutout clear of the glyph.
 */
function cutoutMask(px: number, overlap: number, travel: number): string {
  const width = px + travel
  const side = px + CUT_GAP * 2
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${px}">` +
    `<mask id="m"><rect width="100%" height="100%" fill="white"/>` +
    `<rect x="${travel + px - overlap - CUT_GAP}" y="${-CUT_GAP}" width="${side}" height="${side}" rx="${GLYPH_RADIUS + CUT_GAP}" fill="black"/></mask>` +
    `<rect width="100%" height="100%" mask="url(#m)"/></svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
}

/** How far the last glyph travels right when a stack of `count` fans out. */
export function labelFanReach(count: number, size: keyof typeof STACK_SIZES): number {
  const { overlap } = STACK_SIZES[size]
  return (count - 1) * (overlap + FAN_GAP)
}

/**
 * Collapsed label marks: glyphs overlapping left to right, each tucked behind
 * the next, so the last one sits whole at the right edge. With `fan`, hovering
 * the nearest `group/label-stack` ancestor spreads them like a hand of cards:
 * the first holds its place and the rest fan out to its right, so the spread
 * never covers what precedes the stack. Transforms only, so nothing around it
 * moves (INV-21); the caller's container must leave `labelFanReach` of room to
 * the right for it to paint.
 */
export function LabelGlyphStack({
  labels,
  size,
  fan = false,
  className,
}: {
  labels: readonly (LabelChipLabel & { id: string })[]
  size: keyof typeof STACK_SIZES
  fan?: boolean
  className?: string
}) {
  const { glyph, px, overlap } = STACK_SIZES[size]
  const travel = overlap + FAN_GAP
  const mask = cutoutMask(px, overlap, travel)
  const center = (labels.length - 1) / 2

  return (
    <span className={cn("flex items-center", className)}>
      {labels.map((label, index) => {
        const tucked = index < labels.length - 1
        const style = {
          marginLeft: index > 0 ? -overlap : undefined,
          "--index": index,
          "--tilt": index - center,
          "--travel": `${travel}px`,
          ...(tucked && { maskImage: mask, maskSize: `${px + travel}px ${px}px`, maskRepeat: "no-repeat" }),
        } as CSSProperties
        return (
          <LabelGlyph
            key={label.id}
            label={label}
            style={style}
            className={cn(
              glyph,
              tucked && "[mask-position:calc(var(--travel)*-1)_0]",
              fan &&
                "transition-[transform,mask-position] duration-200 ease-out [transform-origin:50%_100%] motion-reduce:transition-none",
              fan &&
                "group-hover/label-stack:[transform:translateX(calc(var(--index)*var(--travel)))_rotate(calc(var(--tilt)*8deg))]",
              fan && tucked && "group-hover/label-stack:[mask-position:0_0]"
            )}
          />
        )
      })}
    </span>
  )
}
