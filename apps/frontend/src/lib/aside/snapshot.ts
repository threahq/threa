import {
  ContextIntents,
  ContextRefKinds,
  VIEWPORT_MAX_VISIBLE_IDS,
  type ContextBag,
  type ContextRef,
  type ViewportContextRef,
} from "@threa/types"
import { collectRowRects, pickVisibleRows, readViewportBounds, type VisibleRow } from "@/lib/timeline/visible-rows"

/**
 * The message ids on screen, top to bottom, capped at `max`. When more rows fit
 * than the cap allows, the bottom-most survive: the timeline's bottom is the
 * most recent content and the part nearest the composer the user is about to
 * reply from.
 */
export function pickVisibleMessageIds(
  rows: VisibleRow[],
  bounds: { top: number; bottom: number },
  max: number = VIEWPORT_MAX_VISIBLE_IDS
): string[] {
  const ids = pickVisibleRows(rows, bounds).map((row) => row.id)
  return ids.length > max ? ids.slice(ids.length - max) : ids
}

/** The message ids currently on screen in a timeline scroller, top to bottom. */
export function captureViewportMessageIds(scroller: HTMLElement): string[] {
  return pickVisibleMessageIds(collectRowRects(scroller, "messageId"), readViewportBounds(scroller))
}

/**
 * The viewport snapshot an aside is created with: what the user had on screen
 * in `streamId` at the moment of capture. Null when no message row is visible
 * (an empty stream, or a viewport showing only chrome) — the create call then
 * simply carries no viewport ref.
 */
export function buildViewportRef(scroller: HTMLElement, streamId: string): ViewportContextRef | null {
  const visibleMessageIds = captureViewportMessageIds(scroller)
  if (visibleMessageIds.length === 0) return null
  return {
    kind: ContextRefKinds.VIEWPORT,
    streamId,
    visibleMessageIds,
    capturedAt: new Date().toISOString(),
  }
}

/** The context bag for an aside; `refs` is the viewport ref or the conversation refs of the host surface. */
export function buildAsideBag(refs: ContextRef[]): ContextBag {
  return { intent: ContextIntents.ASIDE, refs }
}
