import { useState, useEffect, useRef, useCallback } from "react"

interface UseResizeDragOptions {
  /** Current width of the resizable element */
  width: number
  /** Called at most once per animation frame with the live drag width */
  onWidthChange: (newWidth: number) => void
  /**
   * Which way the pointer must travel to make the element bigger: "right"
   * (sidebar), "left" (a right-edge panel), or "up" (a region growing from the
   * bottom of its column, e.g. a stacked split). "up"/"down" read clientY.
   */
  direction?: "right" | "left" | "up" | "down"
  /** Called when drag starts */
  onResizeStart?: () => void
  /** Called once with the final width when the pointer is released or cancelled */
  onResizeEnd?: (finalWidth: number) => void
}

interface UseResizeDragReturn {
  isResizing: boolean
  handleResizeStart: (e: React.PointerEvent) => void
  handleResizeMove: (e: React.PointerEvent) => void
  handleResizeEnd: (e: React.PointerEvent) => void
}

interface ResizeState {
  pointerId: number
  startPos: number
  startWidth: number
  latestWidth: number
  emittedWidth: number
}

const isVertical = (direction: "right" | "left" | "up" | "down") => direction === "up" || direction === "down"

function dragDelta(
  event: React.PointerEvent,
  resize: ResizeState,
  direction: "right" | "left" | "up" | "down"
): number {
  const raw = (isVertical(direction) ? event.clientY : event.clientX) - resize.startPos
  return direction === "right" || direction === "down" ? raw : -raw
}

export function useResizeDrag({
  width,
  onWidthChange,
  direction = "right",
  onResizeStart,
  onResizeEnd,
}: UseResizeDragOptions): UseResizeDragReturn {
  const [isResizing, setIsResizing] = useState(false)
  const resizeRef = useRef<ResizeState | null>(null)
  const frameRef = useRef<number | null>(null)

  const flushWidthChange = useCallback(() => {
    frameRef.current = null
    const resize = resizeRef.current
    if (resize) {
      resize.emittedWidth = resize.latestWidth
      onWidthChange(resize.latestWidth)
    }
  }, [onWidthChange])

  const handleResizeStart = useCallback(
    (e: React.PointerEvent) => {
      if (!e.isPrimary || e.button !== 0 || resizeRef.current) return
      e.preventDefault()
      e.stopPropagation()
      resizeRef.current = {
        pointerId: e.pointerId,
        startPos: isVertical(direction) ? e.clientY : e.clientX,
        startWidth: width,
        latestWidth: width,
        emittedWidth: width,
      }
      e.currentTarget.setPointerCapture(e.pointerId)
      setIsResizing(true)
      onResizeStart?.()
    },
    [width, direction, onResizeStart]
  )

  const handleResizeMove = useCallback(
    (e: React.PointerEvent) => {
      const resize = resizeRef.current
      if (!resize || resize.pointerId !== e.pointerId) return

      resize.latestWidth = resize.startWidth + dragDelta(e, resize, direction)
      if (frameRef.current === null) frameRef.current = requestAnimationFrame(flushWidthChange)
    },
    [direction, flushWidthChange]
  )

  const handleResizeEnd = useCallback(
    (e: React.PointerEvent) => {
      const resize = resizeRef.current
      if (!resize || resize.pointerId !== e.pointerId) return

      if (e.type === "pointerup") {
        resize.latestWidth = resize.startWidth + dragDelta(e, resize, direction)
      } else {
        resize.latestWidth = resize.startWidth
      }
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
      if (resize.latestWidth !== resize.emittedWidth) onWidthChange(resize.latestWidth)
      resizeRef.current = null
      setIsResizing(false)
      onResizeEnd?.(resize.latestWidth)
    },
    [direction, onWidthChange, onResizeEnd]
  )

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    },
    []
  )

  return { isResizing, handleResizeStart, handleResizeMove, handleResizeEnd }
}
