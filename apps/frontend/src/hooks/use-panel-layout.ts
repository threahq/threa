import { useState, useEffect, useRef, useCallback } from "react"
import { useResizeDrag } from "./use-resize-drag"
import { useElementWidth } from "./use-element-width"

const DEFAULT_PANEL_WIDTH = 480
const MIN_PANEL_WIDTH = 300
const MAX_PANEL_RATIO = 0.7
// Keep the main stream column wide enough to stay usable — below this the
// composer toolbar can't lay out and the timeline gets unreadably narrow. The
// panel yields to it (caps below 0.7 of the container) until the container is
// itself so small that MIN_PANEL_WIDTH wins; the composer's own overflow
// handling covers that degenerate tail.
const MIN_MAIN_WIDTH = 400

/** Largest the panel may be without crushing the main column below MIN_MAIN_WIDTH. */
function panelMaxWidth(containerWidth: number): number {
  if (containerWidth <= 0) return 0
  const ratioCap = Math.round(containerWidth * MAX_PANEL_RATIO)
  const mainFloorCap = containerWidth - MIN_MAIN_WIDTH
  return Math.max(MIN_PANEL_WIDTH, Math.min(ratioCap, mainFloorCap))
}

export function usePanelLayout(isPanelOpen: boolean) {
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH)
  const [enableTransition, setEnableTransition] = useState(false)
  const [showContent, setShowContent] = useState(isPanelOpen)
  const containerRef = useRef<HTMLDivElement>(null)
  const closedDuringResizeRef = useRef(false)

  // Live-clamped panel width: opening a panel — or a smaller window / sidebar
  // collapse — re-caps the stored width so the default 480 can't crush the main
  // column before the user drags. `useElementWidth` (ResizeObserver) keeps this
  // reactive to container resize, not just to React state changes. Guarded on a
  // real measurement so the first pre-measure render doesn't collapse the panel
  // to MIN and flash. Drag and keyboard resize base off this clamped value (not
  // the raw state) so they don't jump on a constrained window.
  const containerWidth = useElementWidth(containerRef)
  const maxWidth = panelMaxWidth(containerWidth)
  const effectiveWidth = containerWidth > 0 ? Math.max(MIN_PANEL_WIDTH, Math.min(maxWidth, panelWidth)) : panelWidth

  // Enable transitions after first paint to prevent animation on page load
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setEnableTransition(true)
    })
    return () => cancelAnimationFrame(frame)
  }, [])

  const handleTransitionEnd = useCallback(
    (e: React.TransitionEvent) => {
      // Only respond to our own width transition, not bubbled child transitions
      // (e.g. resize handle's transition-colors finishes 50ms earlier)
      if (e.propertyName === "width" && e.target === e.currentTarget && !isPanelOpen) {
        setShowContent(false)
      }
    },
    [isPanelOpen]
  )

  const handleWidthChange = useCallback(
    (newWidth: number) => {
      // No measurement yet (pre-mount drag is impossible, but stay safe) — skip.
      if (containerWidth <= 0) return
      setPanelWidth(Math.max(MIN_PANEL_WIDTH, Math.min(maxWidth, newWidth)))
    },
    [containerWidth, maxWidth]
  )

  const { isResizing, handleResizeStart, handleResizeMove, handleResizeEnd } = useResizeDrag({
    width: effectiveWidth,
    onWidthChange: handleWidthChange,
    direction: "left",
  })

  // Content mount/unmount lifecycle — keep content mounted during close animation
  useEffect(() => {
    if (isPanelOpen) {
      closedDuringResizeRef.current = false
      setShowContent(true)
    } else if (isResizing) {
      closedDuringResizeRef.current = true
    } else if (!enableTransition || closedDuringResizeRef.current) {
      closedDuringResizeRef.current = false
      setShowContent(false)
    }
  }, [isPanelOpen, enableTransition, isResizing])

  const handleResizeKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const step = e.shiftKey ? 50 : 10
      if (e.key === "ArrowLeft") {
        e.preventDefault()
        handleWidthChange(effectiveWidth + step)
      } else if (e.key === "ArrowRight") {
        e.preventDefault()
        handleWidthChange(effectiveWidth - step)
      }
    },
    [effectiveWidth, handleWidthChange]
  )

  return {
    containerRef,
    panelWidth: effectiveWidth,
    maxWidth,
    minWidth: MIN_PANEL_WIDTH,
    displayWidth: isPanelOpen ? effectiveWidth : 0,
    shouldAnimate: enableTransition && !isResizing,
    isResizing,
    showContent,
    handleResizeStart,
    handleResizeMove,
    handleResizeEnd,
    handleResizeKeyDown,
    handleTransitionEnd,
  }
}
