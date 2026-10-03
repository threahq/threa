import { useLayoutEffect } from "react"
import { cn } from "@/lib/utils"
import { PanelResizeHandle } from "./panel-resize-handle"

// Keep in sync with the `duration-200` class on the slot: consumers of
// `--panel-inset-duration` animate their edge against this element's width.
const PANEL_TRANSITION_MS = 200

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
  useLayoutEffect(() => {
    const root = document.documentElement
    root.style.setProperty("--panel-inset-right", `${insetRight}px`)
    root.style.setProperty("--panel-inset-duration", insetAnimates ? `${PANEL_TRANSITION_MS}ms` : "0ms")
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

  return (
    <div
      data-testid={testId}
      inert={inert || undefined}
      className={cn("flex-shrink-0 overflow-hidden", shouldAnimate && "transition-[width] duration-200 ease-out")}
      style={{ width: displayWidth }}
      onTransitionEnd={onTransitionEnd}
    >
      {showContent && (
        <div className="flex h-full" style={{ width: panelWidth, minWidth: panelWidth }}>
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
          />
          <div className="flex-1 min-w-0 overflow-hidden">{children}</div>
        </div>
      )}
    </div>
  )
}
