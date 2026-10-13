import type { CSSProperties } from "react"
import { GripHorizontal, GripVertical } from "lucide-react"
import { cn } from "@/lib/utils"

interface PanelResizeHandleProps {
  isResizing: boolean
  panelWidth: number
  minWidth: number
  maxWidth: number
  onPointerDown: (e: React.PointerEvent) => void
  onPointerMove: (e: React.PointerEvent) => void
  onPointerEnd: (e: React.PointerEvent) => void
  onKeyDown: (e: React.KeyboardEvent) => void
  /** A double click or double tap: sizes every pane along this divider equally. */
  onReset?: () => void
  ariaLabel?: string
  /** `"y"` divides stacked sections: a horizontal hairline dragged up and down. */
  axis?: "x" | "y"
  className?: string
  style?: CSSProperties
  inert?: boolean
}

export function PanelResizeHandle({
  isResizing,
  panelWidth,
  minWidth,
  maxWidth,
  onPointerDown,
  onPointerMove,
  onPointerEnd,
  onKeyDown,
  onReset,
  ariaLabel = "Resize thread panel",
  axis = "x",
  className,
  style,
  inert,
}: PanelResizeHandleProps) {
  const Grip = axis === "x" ? GripVertical : GripHorizontal
  return (
    <div
      style={style}
      inert={inert}
      className={cn(
        "relative flex flex-shrink-0 items-center justify-center bg-border",
        axis === "x"
          ? "resize-handle-touch-target w-px touch-pan-y cursor-col-resize after:absolute after:left-1/2 after:-translate-x-1/2"
          : "resize-handle-touch-target-y h-px touch-pan-x cursor-row-resize after:absolute after:top-1/2 after:-translate-y-1/2",
        "focus-visible:bg-primary/30 focus-visible:outline-none",
        !isResizing && "transition-colors duration-150",
        isResizing && "bg-primary/30",
        className
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onLostPointerCapture={onPointerEnd}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
      tabIndex={0}
      role="separator"
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      aria-valuenow={panelWidth}
      aria-valuemin={minWidth}
      aria-valuemax={maxWidth}
      aria-label={ariaLabel}
    >
      <div
        className={cn(
          "z-10 flex items-center justify-center rounded-sm border bg-border",
          axis === "x" ? "h-4 w-3" : "h-3 w-4"
        )}
      >
        <Grip className="h-2.5 w-2.5" />
      </div>
    </div>
  )
}
