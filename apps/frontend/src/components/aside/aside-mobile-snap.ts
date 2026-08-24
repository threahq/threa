import { nearestStep } from "@/components/call/mobile-call-drawer-snap"
import type { AsideSurface } from "@/stores/aside-store"

/**
 * Drag/snap physics for the mobile aside sheet. The sheet hangs from the BOTTOM
 * and grows upward, so a larger height is a larger surface — the detent maths is
 * the call drawer's (INV-35), only the steps differ.
 *
 * The smallest detent dismisses: dragging the sheet down to the floor closes the
 * aside, and its anchor row in the timeline is the way back. There is no parked
 * state between open and closed.
 */

/** Where a drag can settle: the two reading surfaces, or gone. */
export type AsideDetent = AsideSurface | "closed"
/** The floor a dismissing drag settles on before the sheet leaves. */
export const ASIDE_DISMISS_HEIGHT = 44
/** The peek: enough aside to read and type in, with the host still on screen above it. */
export const ASIDE_PEEK_FRACTION = 0.45

const MOBILE_DETENTS: readonly AsideDetent[] = ["closed", "dock", "fullscreen"]

/** The next detent in `direction` (+1 larger, -1 smaller), clamped at the ends. */
export function steppedAsideSurface(surface: AsideDetent, direction: 1 | -1): AsideDetent {
  const index = MOBILE_DETENTS.indexOf(surface)
  if (index < 0) return surface
  return MOBILE_DETENTS[Math.min(Math.max(index + direction, 0), MOBILE_DETENTS.length - 1)]
}

export function asideMobileSteps(viewportHeight: number): number[] {
  return [ASIDE_DISMISS_HEIGHT, Math.round(viewportHeight * ASIDE_PEEK_FRACTION), viewportHeight]
}

/** The resting height of a detent at this viewport; `closed` is the floor it leaves on. */
export function asideMobileHeight(surface: AsideDetent, viewportHeight: number): number {
  return asideMobileSteps(viewportHeight)[MOBILE_DETENTS.indexOf(surface)] ?? ASIDE_DISMISS_HEIGHT
}

/**
 * The surface to settle on when a drag ends at `heightPx` with
 * `velocityPxPerMs` (positive = growing, i.e. the pointer moving up).
 */
export function nearestAsideSurface(heightPx: number, velocityPxPerMs: number, viewportHeight: number): AsideDetent {
  return MOBILE_DETENTS[nearestStep(heightPx, velocityPxPerMs, asideMobileSteps(viewportHeight))]
}
