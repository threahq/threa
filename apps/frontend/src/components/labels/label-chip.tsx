import type { CSSProperties, ReactNode } from "react"
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
type StackSize = keyof typeof STACK_SIZES
/** Clearance between a tucked glyph and the one in front of it. */
const CUT_GAP = 1.5
/** Space between glyphs once the stack is fanned out. */
const FAN_GAP = 2
/** Angle between neighbouring glyphs once the stack is fanned out. */
const FAN_TILT_DEG = 7
/** LabelGlyph's `rounded` corner, so the cutout traces the front glyph's outline. */
const GLYPH_RADIUS = 4

/** How far a glyph moves away from the one before it when the stack fans out. */
function fanTravel(size: StackSize): number {
  return STACK_SIZES[size].overlap + FAN_GAP
}

/** How far a fanned stack of `count` glyphs reaches past each side of its resting box. */
export function labelFanReach(count: number, size: StackSize): number {
  return ((count - 1) / 2) * fanTravel(size)
}

/**
 * A mask that hides the part of a glyph sitting under its right-hand neighbour:
 * a rounded cutout tracing that neighbour's outline plus `CUT_GAP`. Tints never
 * blend and no surface color is assumed, so it reads the same on a hovered or
 * active row. The image is `travel` wider than the glyph, so sliding it right as
 * the neighbour fans away carries the cutout clear of the glyph.
 */
function cutoutMask(px: number, overlap: number, travel: number): string {
  const side = px + CUT_GAP * 2
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${px + travel}" height="${px}">` +
    `<mask id="m"><rect width="100%" height="100%" fill="white"/>` +
    `<rect x="${travel + px - overlap - CUT_GAP}" y="${-CUT_GAP}" width="${side}" height="${side}" rx="${GLYPH_RADIUS + CUT_GAP}" fill="black"/></mask>` +
    `<rect width="100%" height="100%" mask="url(#m)"/></svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
}

/**
 * Collapsed label marks: glyphs overlapping left to right, each tucked behind
 * the next, so the last one sits whole at the right edge.
 *
 * Inside a `.label-fan` trigger, hovering spreads them like a hand of cards
 * (the `.label-fan-*` rules in index.css). Every glyph turns around one pivot
 * under the stack's centre, so the spread is symmetric: it reaches
 * `labelFanReach` past each side and the container must leave that room to
 * paint. Transforms only, so nothing around the stack moves (INV-21). The
 * glyphs nest — each joint holds its glyph and everything after it — because a
 * joint's progress has to drive both the turn of what follows and the cutout
 * on its own glyph.
 */
export function LabelGlyphStack({
  labels,
  size,
  className,
}: {
  labels: readonly (LabelChipLabel & { id: string })[]
  size: StackSize
  className?: string
}) {
  const { glyph, px, overlap } = STACK_SIZES[size]
  const travel = fanTravel(size)
  const pitch = px - overlap
  const last = labels.length - 1
  // Far enough below the glyphs that one tilt step moves a glyph by `travel`.
  const pivotX = (px + last * pitch) / 2
  const pivotY = px / 2 + travel / ((FAN_TILT_DEG * Math.PI) / 180)
  const pivotFrom = (index: number) => `${pivotX - index * pitch}px ${pivotY}px`
  const cutout: CSSProperties = {
    maskImage: cutoutMask(px, overlap, travel),
    maskSize: `${px + travel}px ${px}px`,
    maskRepeat: "no-repeat",
  }

  const chain = labels.reduceRight<ReactNode>(
    (rest, label, index) =>
      rest === null ? (
        <LabelGlyph label={label} className={glyph} />
      ) : (
        <span className="label-fan-joint flex items-center" style={{ "--label-fan-order": index } as CSSProperties}>
          <LabelGlyph label={label} className={cn(glyph, "label-fan-cut")} style={cutout} />
          <span
            className="label-fan-rest flex items-center"
            style={{ marginLeft: -overlap, transformOrigin: pivotFrom(index + 1) }}
          >
            {rest}
          </span>
        </span>
      ),
    null
  )

  return (
    <span
      className={cn("label-fan-hand flex items-center", className)}
      style={
        {
          "--label-fan-travel": `${travel}px`,
          "--label-fan-tilt": `${FAN_TILT_DEG}deg`,
          "--label-fan-lean": `${(-last / 2) * FAN_TILT_DEG}deg`,
          transformOrigin: pivotFrom(0),
        } as CSSProperties
      }
    >
      {chain}
    </span>
  )
}
