export interface Point {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

export interface Rect extends Point, Size {}

/**
 * Marks an interactive group on a floating call surface — the whole header (grip,
 * title and action pair are one drag surface), the controls row, the pre-join
 * actions, the minimized bar. Anything overlapping
 * one of these both hides a control and eats its clicks, so avoidance scores these
 * regions ahead of the surface as a whole. Semantic, not a test id: the surfaces
 * that own these groups (`call-controls`, `pre-join-gate`) carry the attribute, and
 * whichever floating surface hosts them measures its own subtree.
 */
export const CALL_SURFACE_PROTECTED_ATTR = "data-call-surface-protected"

/** A floating call surface's published viewport geometry. */
export interface FloatingSurfaceGeometry {
  rect: Rect
  /** Viewport rects of the surface's marked interactive groups, measured, not guessed. */
  protectedRects: Rect[]
}

const NO_OFFSET: Point = { x: 0, y: 0 }

/**
 * Clamp a floating square so it stays fully on-screen with `margin` padding. When
 * the square is larger than the viewport the upper bound would go negative, so it
 * floors at `margin` (top-left pinned) rather than clamping to a negative x/y.
 */
export function clampSquareToViewport(pos: Point, size: Size, viewport: Size, margin = 8): Point {
  const maxX = Math.max(margin, viewport.width - size.width - margin)
  const maxY = Math.max(margin, viewport.height - size.height - margin)
  return {
    x: Math.min(Math.max(pos.x, margin), maxX),
    y: Math.min(Math.max(pos.y, margin), maxY),
  }
}

export function anchorSurfaceAtPointer(
  pointer: Point,
  size: Size,
  viewport: Size,
  anchor: Point = { x: size.width / 2, y: size.height / 2 },
  margin = 8
): Point {
  return clampSquareToViewport({ x: pointer.x - anchor.x, y: pointer.y - anchor.y }, size, viewport, margin)
}

function inflate(rect: Rect, by: number): Rect {
  return { x: rect.x - by, y: rect.y - by, width: rect.width + by * 2, height: rect.height + by * 2 }
}

function shift(rect: Rect, offset: Point): Rect {
  return { ...rect, x: rect.x + offset.x, y: rect.y + offset.y }
}

function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

function fitsViewport(rect: Rect, viewport: Size, margin: number): boolean {
  return (
    rect.x >= margin &&
    rect.y >= margin &&
    rect.x + rect.width <= viewport.width - margin &&
    rect.y + rect.height <= viewport.height - margin
  )
}

/**
 * Displacement that moves `surface` (the incoming-ring stack) clear of `obstacle`
 * (the draggable floating call surface), as a translation from the surface's own
 * CSS anchor.
 *
 * Order is load-bearing. Clearing the whole obstacle by `gap` wins outright, first
 * fit of above → left → below → right. Only when none of those fits the viewport
 * do the per-protected-region escapes join the pool, and then every candidate is
 * clamped on-screen and ranked lexicographically: least overlap with the measured
 * `protectedRects`, then least total overlap. Protected-first, not total-first,
 * because the smallest-area placement is often a nudge that still lies across a
 * control group — covering it and eating its clicks — while a larger overlap
 * elsewhere leaves every control reachable. Corner placements are the last tier
 * (see below).
 *
 * Ranking is seeded with staying put and candidates win only on strict
 * improvement, so a tie never translates the ring for nothing. The result depends
 * only on the obstacle's current geometry, never on how it got there.
 */
export function resolveAvoidanceOffset(
  surface: Rect,
  obstacle: FloatingSurfaceGeometry | null,
  viewport: Size,
  gap = 12,
  margin = 8
): Point {
  if (!obstacle) return NO_OFFSET
  const { rect, protectedRects } = obstacle
  if (surface.width <= 0 || surface.height <= 0 || rect.width <= 0 || rect.height <= 0) return NO_OFFSET

  const blocked = inflate(rect, gap)
  if (overlapArea(surface, blocked) === 0) return NO_OFFSET

  const escapes = (box: Rect): Point[] => [
    { x: 0, y: box.y - (surface.y + surface.height) },
    { x: box.x - (surface.x + surface.width), y: 0 },
    { x: 0, y: box.y + box.height - surface.y },
    { x: box.x + box.width - surface.x, y: 0 },
  ]

  const wholeEscapes = escapes(blocked)
  for (const candidate of wholeEscapes) {
    if (fitsViewport(shift(surface, candidate), viewport, margin)) return candidate
  }

  const axisEscapes: Point[] = [...wholeEscapes, ...protectedRects.flatMap((region) => escapes(inflate(region, gap)))]

  const score = (candidate: Point) => {
    const pos = clampSquareToViewport(shift(surface, candidate), surface, viewport, margin)
    const placed = { ...surface, ...pos }
    return {
      offset: { x: pos.x - surface.x, y: pos.y - surface.y },
      protectedArea: protectedRects.reduce((sum, region) => sum + overlapArea(placed, region), 0),
      totalArea: overlapArea(placed, blocked),
    }
  }

  let best = score(NO_OFFSET)
  const rank = (candidates: Point[]) => {
    for (const candidate of candidates) {
      const next = score(candidate)
      if (
        next.protectedArea < best.protectedArea ||
        (next.protectedArea === best.protectedArea && next.totalArea < best.totalArea)
      ) {
        best = next
      }
    }
  }

  rank(axisEscapes)
  // Every escape moves one axis, so regions that box the surface in on different
  // axes are cleared only by a pair. Corner placements are consulted last and
  // only when no single-axis candidate got protected overlap to zero, so they
  // never perturb a placement the axis candidates already settled.
  if (best.protectedArea > 0) {
    rank(axisEscapes.flatMap((horizontal) => axisEscapes.map((vertical) => ({ x: horizontal.x, y: vertical.y }))))
  }
  return best.offset
}

/**
 * Whether the placement actually applied — the offset from
 * {@link resolveAvoidanceOffset} after the caller rounds it to whole pixels —
 * still lies across a measured interactive group.
 *
 * In a viewport too crowded for any clear placement this is the signal that
 * geometry has run out, and the caller drops the ring one stacking level so the
 * floating surface paints above it and keeps its clicks. Takes the rounded offset
 * rather than recomputing, because the rendered transform is what the user's
 * pointer actually hits.
 */
export function placementOverlapsProtected(
  surface: Rect,
  offset: Point,
  obstacle: FloatingSurfaceGeometry | null
): boolean {
  if (!obstacle) return false
  const placed = shift(surface, offset)
  return obstacle.protectedRects.some((region) => overlapArea(placed, region) > 0)
}
