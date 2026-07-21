import { cn } from "@/lib/utils"
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
