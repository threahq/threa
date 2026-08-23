import { nearestStep } from "@/components/call/mobile-call-drawer-snap"
import type { AsideSurface } from "@/stores/aside-store"

/**
 * Drag/snap physics for the mobile aside sheet. The sheet hangs from the BOTTOM
 * and grows upward, so a larger height is a larger surface — the detent maths is
 * the call drawer's (INV-35), only the steps differ.
 *
 * Minimized is a real detent here: dragging the sheet down to the tab height
 * parks the aside in the strip above the composer, which is the same state the
 * desktop minimize button reaches.
 */
export const ASIDE_TAB_HEIGHT = 44
/** The peek: enough aside to read and type in, with the host still on screen above it. */
export const ASIDE_PEEK_FRACTION = 0.45

const MOBILE_SURFACES: readonly AsideSurface[] = ["minimized", "dock", "fullscreen"]

/** The next detent in `direction` (+1 larger, -1 smaller), clamped at the ends. */
export function steppedAsideSurface(surface: AsideSurface, direction: 1 | -1): AsideSurface {
  const index = MOBILE_SURFACES.indexOf(surface)
  if (index < 0) return surface
  return MOBILE_SURFACES[Math.min(Math.max(index + direction, 0), MOBILE_SURFACES.length - 1)]
}

export function asideMobileSteps(viewportHeight: number): number[] {
  return [ASIDE_TAB_HEIGHT, Math.round(viewportHeight * ASIDE_PEEK_FRACTION), viewportHeight]
}

/** The resting height of a surface at this viewport; `minimized` is the parked tab. */
export function asideMobileHeight(surface: AsideSurface, viewportHeight: number): number {
  return asideMobileSteps(viewportHeight)[MOBILE_SURFACES.indexOf(surface)] ?? ASIDE_TAB_HEIGHT
}

/**
 * The surface to settle on when a drag ends at `heightPx` with
 * `velocityPxPerMs` (positive = growing, i.e. the pointer moving up).
 */
export function nearestAsideSurface(heightPx: number, velocityPxPerMs: number, viewportHeight: number): AsideSurface {
  return MOBILE_SURFACES[nearestStep(heightPx, velocityPxPerMs, asideMobileSteps(viewportHeight))]
}
