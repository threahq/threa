import type { CallSurfaceMode } from "@/stores/call-store"

/**
 * Drag/snap physics for the mobile call drawer, factored out as pure functions so
 * the detent logic is unit-testable without a real pointer drag.
 *
 * The drawer hangs from the top and grows DOWNWARD, so a larger height = a larger
 * surface mode. Heights are the resting pixel size of each mode's chrome; `full`
 * renders at `100dvh` but for snapping we only need a representative anchor well
 * past `standard` (any drag beyond the standard↔full midpoint lands on full).
 */

export const DRAWER_MIN_HEIGHT = 44
export const DRAWER_COMPACT_HEIGHT = 80
export const DRAWER_STANDARD_HEIGHT = 248
/** Snap anchor for `full` (rendered at 100dvh); crossing the standard↔full midpoint snaps to full. */
export const DRAWER_FULL_SNAP_HEIGHT = 420

/** A flick faster than this (px/ms, magnitude) biases the snap one detent in its direction. */
export const FLICK_VELOCITY = 0.5

const MODES: readonly CallSurfaceMode[] = ["min", "compact", "standard", "full"]
const HEIGHTS: readonly number[] = [
  DRAWER_MIN_HEIGHT,
  DRAWER_COMPACT_HEIGHT,
  DRAWER_STANDARD_HEIGHT,
  DRAWER_FULL_SNAP_HEIGHT,
]

/**
 * The detent index to settle on when a drag ends at `value` with `velocity`
 * (positive = growing toward a larger step). Nearest detent by distance, then a
 * fast flick jumps to the next detent in the flick direction (so a quick pull
 * past a small threshold advances even if the pointer didn't travel the whole
 * way). Orientation-agnostic: the mobile drawer passes resting heights, the
 * desktop dock passes its per-orientation widths/heights (INV-35).
 */
export function nearestStep(value: number, velocity: number, steps: readonly number[]): number {
  let idx = 0
  let best = Infinity
  for (let i = 0; i < steps.length; i++) {
    const d = Math.abs(steps[i] - value)
    if (d < best) {
      best = d
      idx = i
    }
  }

  if (velocity > FLICK_VELOCITY) {
    const nextUp = steps.findIndex((s) => s > value)
    const target = nextUp === -1 ? steps.length - 1 : nextUp
    return Math.max(idx, target)
  }

  if (velocity < -FLICK_VELOCITY) {
    let nextDown = 0
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i] < value) {
        nextDown = i
        break
      }
    }
    return Math.min(idx, nextDown)
  }

  return idx
}

/**
 * The mode to settle on when a drawer drag ends at `heightPx` with
 * `velocityPxPerMs` (positive = growing/downward). Delegates the detent physics
 * to {@link nearestStep} with the drawer's resting heights.
 */
export function nearestMode(heightPx: number, velocityPxPerMs: number): CallSurfaceMode {
  return MODES[nearestStep(heightPx, velocityPxPerMs, HEIGHTS)]
}
