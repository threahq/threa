import { useState, useEffect, useRef, useCallback, type RefObject } from "react"
import { useResizeDrag } from "./use-resize-drag"
import { useElementWidth } from "./use-element-width"
import { BESIDE_SPLIT_RATIO } from "@/lib/panel-grid"

const DEFAULT_PANEL_WIDTH = 480
export const MIN_PANEL_WIDTH = 300
const MAX_PANEL_RATIO = 0.7
// Keep the main stream column wide enough to stay usable — below this the
// composer toolbar can't lay out and the timeline gets unreadably narrow. The
// panel yields to it (caps below 0.7 of the container) until the container is
// itself so small that MIN_PANEL_WIDTH wins; the composer's own overflow
// handling covers that degenerate tail.
export const MIN_MAIN_WIDTH = 400

/** Largest the panel may be without crushing the main column below MIN_MAIN_WIDTH. */
function panelMaxWidth(containerWidth: number): number {
  if (containerWidth <= 0) return 0
  const ratioCap = Math.round(containerWidth * MAX_PANEL_RATIO)
  const mainFloorCap = containerWidth - MIN_MAIN_WIDTH
  return Math.max(MIN_PANEL_WIDTH, Math.min(ratioCap, mainFloorCap))
}

interface PanelLayoutOptions {
  /** Measure the page's container instead of one of its own. */
  containerRef?: RefObject<HTMLDivElement | null>
  /** Width other docked columns in the row already take; the panel clamps against what is left. */
  reservedWidth?: number
  /** Whether a close animates the column away. One that doesn't never ends a transition, so content goes at once. */
  animates?: boolean
  /** Side-by-side columns the panel's arrangement has. The panel widens for each one that fits. */
  columns?: number
}

export function usePanelLayout(isPanelOpen: boolean, options: PanelLayoutOptions = {}) {
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH)
  const [enableTransition, setEnableTransition] = useState(false)
  const [showContent, setShowContent] = useState(isPanelOpen)
  const ownContainerRef = useRef<HTMLDivElement>(null)
  const containerRef = options.containerRef ?? ownContainerRef
  const closedDuringResizeRef = useRef(false)
  const animates = options.animates ?? true

  // Live-clamped panel width: opening a panel — or a smaller window / sidebar
  // collapse — re-caps the stored width so the default 480 can't crush the main
  // column before the user drags. `useElementWidth` (ResizeObserver) keeps this
  // reactive to container resize, not just to React state changes. Guarded on a
  // real measurement so the first pre-measure render doesn't collapse the panel
  // to MIN and flash. Drag and keyboard resize base off this clamped value (not
  // the raw state) so they don't jump on a constrained window.
  const measuredWidth = useElementWidth(containerRef)
  const containerWidth = measuredWidth > 0 ? Math.max(1, measuredWidth - (options.reservedWidth ?? 0)) : 0
  const maxWidth = panelMaxWidth(containerWidth)
  // The stored width is the first column's; each column beside it adds its
  // share of that (a panel opened beside another takes 1 to its 1.4).
  const requestedColumns = Math.max(1, options.columns ?? 1)
  const maxColumns =
    containerWidth > 0 ? Math.max(1, Math.floor((containerWidth - MIN_MAIN_WIDTH) / MIN_PANEL_WIDTH)) : requestedColumns
  const columns = Math.min(requestedColumns, maxColumns)
  const scale = 1 + (columns - 1) / BESIDE_SPLIT_RATIO
  const minWidth = Math.min(MIN_PANEL_WIDTH * columns, Math.max(MIN_PANEL_WIDTH, maxWidth))
  const effectiveWidth =
    containerWidth > 0 ? Math.max(minWidth, Math.min(maxWidth, Math.round(panelWidth * scale))) : panelWidth * scale

  // Enable transitions after first paint to prevent animation on page load
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setEnableTransition(true)
    })
    return () => cancelAnimationFrame(frame)
  }, [])

  const handleTransitionEnd = useCallback(
    (e: React.TransitionEvent) => {
      // Only respond to our own width transition — a slot's width, or the track
      // of a pane host's grid — not bubbled child transitions (the resize
      // handle's transition-colors finishes 50ms earlier).
      const ownWidth = e.propertyName === "width" || e.propertyName === "grid-template-columns"
      if (ownWidth && e.target === e.currentTarget && !isPanelOpen) {
        setShowContent(false)
      }
    },
    [isPanelOpen]
  )

  const handleWidthChange = useCallback(
    (newWidth: number) => {
      // No measurement yet (pre-mount drag is impossible, but stay safe) — skip.
      if (containerWidth <= 0) return
      setPanelWidth(Math.max(minWidth, Math.min(maxWidth, newWidth)) / scale)
    },
    [containerWidth, minWidth, maxWidth, scale]
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
    } else if (!enableTransition || !animates || closedDuringResizeRef.current) {
      closedDuringResizeRef.current = false
      setShowContent(false)
    }
  }, [isPanelOpen, enableTransition, isResizing, animates])

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

  // Every column the same width: the panel takes all of them but the main one's share, within its caps.
  const handleResizeReset = useCallback(
    () => handleWidthChange((containerWidth * columns) / (columns + 1)),
    [handleWidthChange, containerWidth, columns]
  )

  return {
    containerRef,
    panelWidth: effectiveWidth,
    maxWidth,
    minWidth,
    /** How many columns fit side by side, whether or not the arrangement has them. */
    maxColumns,
    displayWidth: isPanelOpen ? effectiveWidth : 0,
    shouldAnimate: enableTransition && !isResizing,
    isResizing,
    showContent,
    handleResizeStart,
    handleResizeMove,
    handleResizeEnd,
    handleResizeKeyDown,
    handleResizeReset,
    handleTransitionEnd,
  }
}
