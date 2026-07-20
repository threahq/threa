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

function nearestIndex(heightPx: number): number {
  let idx = 0
  let best = Infinity
  for (let i = 0; i < HEIGHTS.length; i++) {
    const d = Math.abs(HEIGHTS[i] - heightPx)
    if (d < best) {
      best = d
      idx = i
    }
  }
  return idx
}

/**
 * The mode to settle on when a drag ends at `heightPx` with `velocityPxPerMs`
 * (positive = growing/downward). Nearest detent by distance, then a fast flick
 * jumps to the next detent in the flick direction (so a quick pull past a small
 * threshold advances even if the finger didn't travel the whole way).
 */
export function nearestMode(heightPx: number, velocityPxPerMs: number): CallSurfaceMode {
  const idx = nearestIndex(heightPx)

  if (velocityPxPerMs > FLICK_VELOCITY) {
    const nextUp = HEIGHTS.findIndex((h) => h > heightPx)
    const target = nextUp === -1 ? HEIGHTS.length - 1 : nextUp
    return MODES[Math.max(idx, target)]
  }

  if (velocityPxPerMs < -FLICK_VELOCITY) {
    let nextDown = 0
    for (let i = HEIGHTS.length - 1; i >= 0; i--) {
      if (HEIGHTS[i] < heightPx) {
        nextDown = i
        break
      }
    }
    return MODES[Math.min(idx, nextDown)]
  }

  return MODES[idx]
}
