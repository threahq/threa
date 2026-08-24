import { GripHorizontal } from "lucide-react"
import { ASIDE_DRAFT_MIN_HEIGHT } from "@/stores/aside-store"
import { cn } from "@/lib/utils"
import type { AsideSplit } from "./use-aside-split"

/**
 * The divider between the draft and the conversation. A sibling of
 * `PanelResizeHandle` turned on its side — same hairline-plus-grip, same
 * keyboard contract, same enlarged hit strip — because the aside is the first
 * surface in the app that splits a column rather than a row.
 */
export function AsideSplitHandle({ split }: { split: AsideSplit }) {
  return (
    <div
      className={cn(
        "resize-handle-touch-target-y relative flex h-px shrink-0 cursor-row-resize touch-pan-x items-center justify-center bg-border",
        // The hairline is 1px; the grabbable strip is the pseudo-element, 4px
        // for a mouse and 44px under a coarse pointer — `PanelResizeHandle`'s
        // deal, on the other axis.
        "after:absolute after:top-1/2 after:-translate-y-1/2",
        "focus-visible:bg-primary/30 focus-visible:outline-none",
        !split.isResizing && "transition-colors duration-150",
        split.isResizing && "bg-primary/30"
      )}
      onPointerDown={split.onPointerDown}
      onPointerMove={split.onPointerMove}
      onPointerUp={split.onPointerEnd}
      onPointerCancel={split.onPointerEnd}
      onLostPointerCapture={split.onPointerEnd}
      onKeyDown={split.onKeyDown}
      tabIndex={0}
      role="separator"
      aria-orientation="horizontal"
      aria-valuenow={split.height}
      aria-valuemin={ASIDE_DRAFT_MIN_HEIGHT}
      aria-valuemax={split.maxHeight}
      aria-label="Resize draft"
    >
      <div className="z-10 flex h-3 w-4 items-center justify-center rounded-sm border bg-border">
        <GripHorizontal className="h-2.5 w-2.5" />
      </div>
    </div>
  )
}
