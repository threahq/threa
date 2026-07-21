import { useState, useEffect, useRef, useCallback } from "react"

interface UseResizeDragOptions {
  /** Current width of the resizable element */
  width: number
  /** Called at most once per animation frame with the live drag width */
  onWidthChange: (newWidth: number) => void
  /** "right" = dragging right increases width (sidebar), "left" = dragging left increases width (right-side panel) */
  direction?: "right" | "left"
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
  startX: number
  startWidth: number
  latestWidth: number
  emittedWidth: number
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
      e.preventDefault()
      e.stopPropagation()
      resizeRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startWidth: width,
        latestWidth: width,
        emittedWidth: width,
      }
      e.currentTarget.setPointerCapture(e.pointerId)
      setIsResizing(true)
      onResizeStart?.()
    },
    [width, onResizeStart]
  )

  const handleResizeMove = useCallback(
    (e: React.PointerEvent) => {
      const resize = resizeRef.current
      if (!resize || resize.pointerId !== e.pointerId) return

      const rawDelta = e.clientX - resize.startX
      const delta = direction === "right" ? rawDelta : -rawDelta
      resize.latestWidth = resize.startWidth + delta
      if (frameRef.current === null) frameRef.current = requestAnimationFrame(flushWidthChange)
    },
    [direction, flushWidthChange]
  )

  const handleResizeEnd = useCallback(
    (e: React.PointerEvent) => {
      const resize = resizeRef.current
      if (!resize || resize.pointerId !== e.pointerId) return

      if (e.type === "pointerup") {
        const rawDelta = e.clientX - resize.startX
        const delta = direction === "right" ? rawDelta : -rawDelta
        resize.latestWidth = resize.startWidth + delta
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
