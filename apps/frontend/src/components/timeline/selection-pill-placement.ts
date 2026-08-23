/**
 * Where the floating quote/share pill goes for a touch selection.
 *
 * Three things we don't own want this strip of screen and none of them can be
 * measured from script. Android's text-selection toolbar (Copy / Share / Select
 * all) takes the space above the selection whenever there is room for it
 * between the selection and the top of the web contents; inside a sheet that
 * starts well below that top there always is, so it is always above and the
 * space below the selection is always ours. The selection's drag handles hang
 * below their own line, so "below" still has to clear them. Chrome's Touch to
 * Search peek draws over the bottom of the page without resizing the visual
 * viewport, so the caller subtracts {@link RESERVED_BOTTOM_PX} from the bounds
 * it passes in and nothing is ever placed there.
 */

export interface Box {
  top: number
  bottom: number
  left: number
  right: number
}

export interface Size {
  width: number
  height: number
}

export interface Placement {
  top: number
  left: number
}

export interface PlacementInput {
  /** Last line box of the selection and the union of all of them, in client coords. */
  last: Box
  union: Box
  size: Size
  /** The area the pill must stay inside, in client coords. */
  bounds: Box
}

/**
 * Selection drag handles hang below their own line, so a pill sitting flush
 * under the selection covers the end handle and the first tap moves the handle
 * instead of pressing a button.
 */
export const HANDLE_CLEARANCE_PX = 34

/** Bottom band the Touch to Search peek and the gesture bar own. */
export const RESERVED_BOTTOM_PX = 96

const EDGE_PX = 12

/** Pointer travel before a press on the grip becomes a drag. */
export const DRAG_THRESHOLD_PX = 8

/** How close a drop has to land to the automatic spot to re-attach to it. */
export const REATTACH_SNAP_PX = 48

function clampLeft(left: number, size: Size, bounds: Box): number {
  const lo = bounds.left + EDGE_PX
  const hi = bounds.right - EDGE_PX - size.width
  return Math.max(lo, Math.min(left, hi))
}

/** Keeps a point inside the bounds, used for a parked pill and for a live drag. */
export function clampToBounds(point: { top: number; left: number }, size: Size, bounds: Box): Placement {
  return {
    top: Math.max(bounds.top, Math.min(point.top, bounds.bottom - size.height)),
    left: clampLeft(point.left, size, bounds),
  }
}

/**
 * A selection scrolled out of the readable area has nothing to anchor to, and a
 * pill pointing at text nobody can see is worse than no pill. Measured against
 * the scroller itself, not the placement bounds: text under the reserved band
 * is still text the reader can see and quote.
 */
export function isSelectionVisible(union: Box, scroller: Box): boolean {
  return union.bottom > scroller.top && union.top < scroller.bottom
}

export function placeSelectionPill(input: PlacementInput): Placement {
  const { last, union, size, bounds } = input
  const left = clampLeft(union.left + (union.right - union.left) / 2 - size.width / 2, size, bounds)

  const below = last.bottom + HANDLE_CLEARANCE_PX
  if (below >= bounds.top && below + size.height <= bounds.bottom) return { top: below, left }

  // A selection running to the floor leaves no room under it, and above it is
  // where the OS toolbar already is. The pill parks at the floor of the safe
  // area instead, which is still reachable and still clear of the peek.
  return { top: bounds.bottom - size.height, left }
}
