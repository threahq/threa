import { useEffect, useLayoutEffect } from "react"
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
  children,
}: ThreadPanelSlotProps) {
  useLayoutEffect(() => {
    const root = document.documentElement
    root.style.setProperty("--panel-inset-right", `${displayWidth}px`)
    root.style.setProperty("--panel-inset-duration", shouldAnimate ? `${PANEL_TRANSITION_MS}ms` : "0ms")
  }, [displayWidth, shouldAnimate])

  useEffect(
    () => () => {
      const root = document.documentElement
      root.style.setProperty("--panel-inset-right", "0px")
      root.style.setProperty("--panel-inset-duration", "0ms")
    },
    []
  )

  return (
    <div
      data-testid="panel"
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
          />
          <div className="flex-1 min-w-0 overflow-hidden">{children}</div>
        </div>
      )}
    </div>
  )
}
