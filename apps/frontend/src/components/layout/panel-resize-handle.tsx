import { GripVertical } from "lucide-react"
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
  ariaLabel?: string
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
  ariaLabel = "Resize thread panel",
}: PanelResizeHandleProps) {
  return (
    <div
      className={cn(
        "relative flex w-px flex-shrink-0 touch-none items-center justify-center bg-border cursor-col-resize",
        "after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2",
        "[@media(any-pointer:coarse)]:after:w-11",
        "focus-visible:bg-primary/30 focus-visible:outline-none",
        !isResizing && "transition-colors duration-150",
        isResizing && "bg-primary/30"
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onLostPointerCapture={onPointerEnd}
      onKeyDown={onKeyDown}
      tabIndex={0}
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={panelWidth}
      aria-valuemin={minWidth}
      aria-valuemax={maxWidth}
      aria-label={ariaLabel}
    >
      <div className="z-10 flex h-4 w-3 items-center justify-center rounded-sm border bg-border">
        <GripVertical className="h-2.5 w-2.5" />
      </div>
    </div>
  )
}
