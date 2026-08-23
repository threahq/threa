import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react"
import { createPortal } from "react-dom"
import { GripVertical, Quote, Share2 } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  clampToBounds,
  isSelectionVisible,
  placeSelectionPill,
  DRAG_THRESHOLD_PX,
  REATTACH_SNAP_PX,
  RESERVED_BOTTOM_PX,
  type Box,
  type Placement,
  type Size,
} from "./selection-pill-placement"

interface SelectionPillProps {
  /** The selection to act on, or null when there is nothing selected. */
  range: Range | null
  /** Scrollable region the pill stays inside and follows. */
  viewportRef: RefObject<HTMLElement | null>
  /**
   * The sheet the pill renders into. An element, not a ref: vaul swaps the
   * content node across its open transition, and a ref read in an effect keeps
   * whichever node happened to be mounted when that effect last ran.
   */
  portalHost: HTMLElement | null
  /**
   * Raised while a finger is on the pill. A press on it is a press outside the
   * selection, which Chrome collapses, and a drag on it drags a new one; either
   * would tear the pill down between its own pointerup and click. While this is
   * true the owner keeps the selection it already read, and repairs it after.
   */
  onInteractingChange: (interacting: boolean) => void
  onQuote: () => void
  onShare?: () => void
}

/**
 * Floating Quote / Share controls for a touch selection, anchored below the
 * selection and draggable to a spot of the reader's choosing.
 *
 * Placement lives in `selection-pill-placement.ts`; this owns the measuring,
 * the drag, and the portal.
 *
 * It renders inside the sheet, not into `document.body`. A modal sheet sets
 * `pointer-events: none` on the body and `aria-hidden` on everything outside
 * itself, so a pill parked next to it would be both untappable and invisible to
 * a screen reader. Placement is computed in client coordinates and converted to
 * the sheet's box at render, because the sheet animates with a transform and so
 * is the containing block for anything positioned inside it.
 */
export function SelectionPill({
  range,
  viewportRef,
  portalHost,
  onInteractingChange,
  onQuote,
  onShare,
}: SelectionPillProps) {
  const pillRef = useRef<HTMLDivElement>(null)
  const [placement, setPlacement] = useState<Placement | null>(null)
  const [origin, setOrigin] = useState<{ top: number; left: number }>({ top: 0, left: 0 })
  // Where the reader dragged it, in client coords. Deliberately not persisted:
  // opening the view is a fresh read, so the pill starts back at the selection.
  const parkedRef = useRef<{ top: number; left: number } | null>(null)
  const geomRef = useRef<{ bounds: Box; size: Size; auto: Placement } | null>(null)
  const dragRef = useRef<{
    id: number
    grabX: number
    grabY: number
    startX: number
    startY: number
    origin: Placement
    point: { top: number; left: number }
    frame: number
  } | null>(null)
  const [dragging, setDragging] = useState(false)

  const measure = useCallback(() => {
    const scroller = viewportRef.current
    const sheet = portalHost
    const el = pillRef.current
    if (!range || !scroller || !sheet || !el) {
      setPlacement(null)
      return
    }
    const size = { width: el.offsetWidth, height: el.offsetHeight }
    if (size.width === 0) return

    const rects = range.getClientRects()
    const union = range.getBoundingClientRect()
    if (rects.length === 0) {
      setPlacement(null)
      return
    }

    const scrollerRect = scroller.getBoundingClientRect()
    const bounds: Box = {
      top: scrollerRect.top,
      left: scrollerRect.left,
      right: scrollerRect.right,
      bottom: Math.min(scrollerRect.bottom, window.innerHeight) - RESERVED_BOTTOM_PX,
    }
    if (!isSelectionVisible(union, scrollerRect)) {
      setPlacement(null)
      return
    }

    const auto = placeSelectionPill({ last: rects[rects.length - 1], union, size, bounds })
    geomRef.current = { bounds, size, auto }

    const sheetRect = sheet.getBoundingClientRect()
    setOrigin({ top: sheetRect.top + sheet.clientTop, left: sheetRect.left + sheet.clientLeft })

    const parked = parkedRef.current
    setPlacement(parked ? clampToBounds(parked, size, bounds) : auto)
  }, [range, viewportRef, portalHost])

  useLayoutEffect(() => {
    if (dragging) return
    measure()
  }, [measure, dragging])

  // Drop lands the offset back into `top`/`left`, so the transform that carried
  // the drag is cleared in the same commit and the pill never jumps.
  useLayoutEffect(() => {
    if (dragging || !pillRef.current) return
    pillRef.current.style.transform = ""
  }, [dragging, placement])

  useEffect(() => {
    const scroller = viewportRef.current
    if (!range || !scroller) return
    let frame = 0
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (!dragRef.current) measure()
      })
    }
    scroller.addEventListener("scroll", schedule, { passive: true })
    window.addEventListener("resize", schedule)
    window.visualViewport?.addEventListener("resize", schedule)
    window.visualViewport?.addEventListener("scroll", schedule)
    return () => {
      cancelAnimationFrame(frame)
      scroller.removeEventListener("scroll", schedule)
      window.removeEventListener("resize", schedule)
      window.visualViewport?.removeEventListener("resize", schedule)
      window.visualViewport?.removeEventListener("scroll", schedule)
    }
  }, [range, viewportRef, measure])

  const handleGripDown = useCallback(
    (event: React.PointerEvent<HTMLSpanElement>) => {
      if (!placement || dragRef.current) return
      // Capture alone only redirects pointer events; the press would still start
      // a native drag-select over the text underneath and swallow the moves.
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      dragRef.current = {
        id: event.pointerId,
        grabX: event.clientX - placement.left,
        grabY: event.clientY - placement.top,
        startX: event.clientX,
        startY: event.clientY,
        origin: placement,
        point: { top: placement.top, left: placement.left },
        frame: 0,
      }
      onInteractingChange(true)
    },
    [placement, onInteractingChange]
  )

  const handleGripMove = useCallback(
    (event: React.PointerEvent<HTMLSpanElement>) => {
      const drag = dragRef.current
      const geom = geomRef.current
      if (!drag || drag.id !== event.pointerId || !geom) return
      if (!dragging && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < DRAG_THRESHOLD_PX) return
      if (!dragging) setDragging(true)

      const next = clampToBounds(
        { top: event.clientY - drag.grabY, left: event.clientX - drag.grabX },
        geom.size,
        geom.bounds
      )
      drag.point = { top: next.top, left: next.left }

      // The whole drag is one compositor property on one node. Re-rendering per
      // move, or writing `top`/`left`, would put React and a layout pass in the
      // way of every frame, which is what made this feel like it stuttered.
      cancelAnimationFrame(drag.frame)
      drag.frame = requestAnimationFrame(() => {
        const el = pillRef.current
        if (!el) return
        el.style.transform = `translate3d(${next.left - drag.origin.left}px, ${next.top - drag.origin.top}px, 0)`
      })
    },
    [dragging]
  )

  const handleGripUp = useCallback(
    (event: React.PointerEvent<HTMLSpanElement>, cancelled = false) => {
      const drag = dragRef.current
      if (drag && drag.id !== event.pointerId) return
      dragRef.current = null
      const geom = geomRef.current
      // A cancel is the OS taking the gesture away, not a drop, so it reverts
      // to where the pill was rather than parking it under the last finger
      // position. The park is recorded before the guard drops, because dropping
      // it restores the selection and that re-measures against `parkedRef`.
      if (drag && !cancelled && dragging && geom) {
        cancelAnimationFrame(drag.frame)
        // Dropped back where it would have gone on its own: read that as "stop
        // parking me" rather than as a park that happens to match this selection.
        const distance = Math.hypot(drag.point.left - geom.auto.left, drag.point.top - geom.auto.top)
        if (distance <= REATTACH_SNAP_PX) {
          parkedRef.current = null
          setPlacement(geom.auto)
        } else {
          parkedRef.current = drag.point
          setPlacement(drag.point)
        }
      }
      if (drag && cancelled) {
        cancelAnimationFrame(drag.frame)
        setPlacement(drag.origin)
      }
      setDragging(false)
      onInteractingChange(false)
    },
    [dragging, onInteractingChange]
  )

  const handleGripCancel = useCallback(
    (event: React.PointerEvent<HTMLSpanElement>) => handleGripUp(event, true),
    [handleGripUp]
  )

  if (!range || !portalHost) return null

  return createPortal(
    <div
      ref={pillRef}
      role="toolbar"
      aria-label="Selection actions"
      data-testid="selection-pill"
      // The sheet only ignores a press when there is highlighted text, and a
      // press on the pill is exactly what collapses the highlight. Without this
      // a downward drag on the pill drags the sheet down and dismisses it.
      data-vaul-no-drag
      className={cn(
        "absolute z-[60] flex h-11 touch-none select-none items-stretch overflow-hidden rounded-full",
        "border border-border bg-popover/95 shadow-lg backdrop-blur-sm",
        // Named, not bare: a lone `duration-*` transitions `all`, which puts
        // `top`, `left` and the drag transform on the same curve.
        "transition-opacity duration-100",
        dragging && "cursor-grabbing will-change-transform",
        placement ? "opacity-100" : "pointer-events-none opacity-0"
      )}
      style={{ top: (placement?.top ?? 0) - origin.top, left: (placement?.left ?? 0) - origin.left }}
      onPointerDown={() => onInteractingChange(true)}
      onPointerUp={() => onInteractingChange(false)}
    >
      <span
        aria-hidden="true"
        data-testid="selection-pill-grip"
        className={cn(
          "flex touch-none items-center pl-2 pr-1 text-muted-foreground/60",
          dragging ? "text-foreground/70" : "active:text-foreground/70"
        )}
        onPointerDown={handleGripDown}
        onPointerMove={handleGripMove}
        onPointerUp={handleGripUp}
        onPointerCancel={handleGripCancel}
      >
        <GripVertical className="h-4 w-4" />
      </span>

      {onShare && (
        <>
          <button
            type="button"
            className="flex items-center gap-2 px-3.5 text-[13px] font-medium text-secondary-foreground active:bg-muted/70"
            onClick={onShare}
          >
            <Share2 className="h-3.5 w-3.5" />
            Share
          </button>
          <span aria-hidden="true" className="my-2.5 w-px bg-border" />
        </>
      )}

      <button
        type="button"
        className="flex items-center gap-2 pl-3.5 pr-4 text-[13px] font-semibold text-primary active:bg-primary/10"
        onClick={onQuote}
      >
        <Quote className="h-3.5 w-3.5" />
        Quote
      </button>
    </div>,
    portalHost
  )
}
