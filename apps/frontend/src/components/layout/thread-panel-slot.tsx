import { useLayoutEffect } from "react"
import { cn } from "@/lib/utils"
import { PANE_TRANSITION_MS } from "@/components/panes"
import { PanelResizeHandle } from "./panel-resize-handle"

interface ThreadPanelSlotProps {
  displayWidth: number
  panelWidth: number
  shouldAnimate: boolean
  showContent: boolean
  isResizing: boolean
  minWidth: number
  maxWidth: number
  onTransitionEnd: (e: React.TransitionEvent) => void
  onResizeStart: (e: React.PointerEvent) => void
  onResizeMove: (e: React.PointerEvent) => void
  onResizeEnd: (e: React.PointerEvent) => void
  onResizeKeyDown: (e: React.KeyboardEvent) => void
  /** Hold the panel out of the tab order while something covers it. */
  inert?: boolean
  /**
   * Total width docked at the right edge, published as `--panel-inset-right`,
   * and whether its change animates. Every slot in a row publishes the same
   * pair, so their write order is moot.
   */
  insetRight?: number
  insetAnimates?: boolean
  testId?: string
  resizeLabel?: string
  children: React.ReactNode
}

export function ThreadPanelSlot({
  displayWidth,
  panelWidth,
  shouldAnimate,
  showContent,
  isResizing,
  minWidth,
  maxWidth,
  onTransitionEnd,
  onResizeStart,
  onResizeMove,
  onResizeEnd,
  onResizeKeyDown,
  inert,
  insetRight = displayWidth,
  insetAnimates = shouldAnimate,
  testId = "panel",
  resizeLabel,
  children,
}: ThreadPanelSlotProps) {
  usePanelInset(insetRight, insetAnimates)

  return (
    <div
      data-testid={testId}
      inert={inert || undefined}
      className={cn("flex-shrink-0 overflow-hidden", shouldAnimate && "transition-[width] ease-out")}
      style={{ width: displayWidth, transitionDuration: shouldAnimate ? `${PANE_TRANSITION_MS}ms` : undefined }}
      onTransitionEnd={onTransitionEnd}
    >
      {showContent && (
        <ResizablePanelFrame
          panelWidth={panelWidth}
          isResizing={isResizing}
          minWidth={minWidth}
          maxWidth={maxWidth}
          onResizeStart={onResizeStart}
          onResizeMove={onResizeMove}
          onResizeEnd={onResizeEnd}
          onResizeKeyDown={onResizeKeyDown}
          resizeLabel={resizeLabel}
        >
          {children}
        </ResizablePanelFrame>
      )}
    </div>
  )
}

/**
 * Publish the width docked at the right edge as `--panel-inset-right`, and
 * whether its change animates. Every docked column in a row publishes the same
 * pair, so their write order is moot.
 */
export function usePanelInset(insetRight: number, insetAnimates: boolean) {
  useLayoutEffect(() => {
    const root = document.documentElement
    root.style.setProperty("--panel-inset-right", `${insetRight}px`)
    root.style.setProperty("--panel-inset-duration", insetAnimates ? `${PANE_TRANSITION_MS}ms` : "0ms")
  }, [insetRight, insetAnimates])

  // A layout-effect cleanup, not a passive one: routes that each mount their own
  // slot swap instances within a single commit, and React runs every layout
  // teardown before any layout setup — so the outgoing reset lands before the
  // incoming write. As a passive cleanup it would run after paint and blank the
  // inset the new slot had just published.
  useLayoutEffect(
    () => () => {
      const root = document.documentElement
      root.style.setProperty("--panel-inset-right", "0px")
      root.style.setProperty("--panel-inset-duration", "0ms")
    },
    []
  )
}

interface ResizablePanelFrameProps {
  panelWidth: number
  isResizing: boolean
  minWidth: number
  maxWidth: number
  onResizeStart: (e: React.PointerEvent) => void
  onResizeMove: (e: React.PointerEvent) => void
  onResizeEnd: (e: React.PointerEvent) => void
  onResizeKeyDown: (e: React.KeyboardEvent) => void
  resizeLabel?: string
  /**
   * Take the whole cell with no handle — the phone's takeover. The content keeps
   * its place in the tree either way, so crossing the breakpoint doesn't remount it.
   */
  fill?: boolean
  /** Keep the handle out of reach, as under a pane floating over the page. */
  handleInert?: boolean
  children: React.ReactNode
}

/** A side panel's content at its full width, with the resize handle on its left edge. */
export function ResizablePanelFrame({
  panelWidth,
  isResizing,
  minWidth,
  maxWidth,
  onResizeStart,
  onResizeMove,
  onResizeEnd,
  onResizeKeyDown,
  resizeLabel,
  fill = false,
  handleInert,
  children,
}: ResizablePanelFrameProps) {
  return (
    <div className="flex h-full" style={fill ? undefined : { width: panelWidth, minWidth: panelWidth }}>
      {!fill && (
        <PanelResizeHandle
          isResizing={isResizing}
          panelWidth={panelWidth}
          minWidth={minWidth}
          maxWidth={maxWidth}
          onPointerDown={onResizeStart}
          onPointerMove={onResizeMove}
          onPointerEnd={onResizeEnd}
          onKeyDown={onResizeKeyDown}
          ariaLabel={resizeLabel}
          inert={handleInert}
        />
      )}
      <div className="flex-1 min-w-0 overflow-hidden">{children}</div>
    </div>
  )
}
