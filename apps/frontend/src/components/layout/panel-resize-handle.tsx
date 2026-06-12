import { GripVertical } from "lucide-react"
import { cn } from "@/lib/utils"

interface PanelResizeHandleProps {
  isResizing: boolean
  panelWidth: number
  minWidth: number
  maxWidth: number
  onMouseDown: (e: React.MouseEvent) => void
  onKeyDown: (e: React.KeyboardEvent) => void
  /** Double-click equalizes the two panes this divider borders on. */
  onDoubleClick?: () => void
  ariaLabel?: string
}

export function PanelResizeHandle({
  isResizing,
  panelWidth,
  minWidth,
  maxWidth,
  onMouseDown,
  onKeyDown,
  onDoubleClick,
  ariaLabel = "Resize thread panel",
}: PanelResizeHandleProps) {
  return (
    <div
      className={cn(
        "relative flex w-px flex-shrink-0 items-center justify-center bg-border cursor-col-resize",
        "after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2",
        "focus-visible:bg-primary/30 focus-visible:outline-none",
        !isResizing && "transition-colors duration-150",
        isResizing && "bg-primary/30"
      )}
      onMouseDown={onMouseDown}
      onKeyDown={onKeyDown}
      onDoubleClick={onDoubleClick}
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
