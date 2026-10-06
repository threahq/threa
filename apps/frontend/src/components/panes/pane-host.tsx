import type { HTMLAttributes, Ref } from "react"
import { cn } from "@/lib/utils"

/** How long a pane's track takes to open or close. Edges that track a pane animate over the same time. */
export const PANE_TRANSITION_MS = 200

interface PaneHostProps extends HTMLAttributes<HTMLDivElement> {
  /** `grid-template-columns` for the docked arrangement. */
  columns: string
  animate: boolean
  ref?: Ref<HTMLDivElement>
}

/**
 * One grid holding every pane of a page as a flat child. Arrangement changes
 * restyle the panes in place; a pane never moves to another parent, because
 * React would remount it and its scroll offset, draft and focus would go.
 * Overlays a page anchors to this row (`absolute inset-0`) stop at the sidebar.
 */
export function PaneHost({ columns, animate, className, style, ref, ...rest }: PaneHostProps) {
  return (
    <div
      ref={ref}
      className={cn(
        "relative grid h-full min-h-0 grid-rows-[minmax(0,1fr)]",
        animate && "transition-[grid-template-columns] ease-out",
        className
      )}
      style={{
        ...style,
        gridTemplateColumns: columns,
        transitionDuration: animate ? `${PANE_TRANSITION_MS}ms` : undefined,
      }}
      {...rest}
    />
  )
}

interface PaneProps extends HTMLAttributes<HTMLDivElement> {
  /** 1-based grid column. Panes sharing a column stack, and only one is shown. */
  column: number
  /**
   * Covered by another pane in the same cell. `visibility`, never `display`:
   * the box, and with it the scroll offset, has to survive being hidden.
   */
  covered?: boolean
  inert?: boolean
}

export function Pane({ column, covered = false, inert = false, className, style, ...rest }: PaneProps) {
  return (
    <div
      className={cn("min-h-0 min-w-0 overflow-hidden", covered && "invisible", className)}
      style={{ ...style, gridArea: `1 / ${column}` }}
      inert={covered || inert || undefined}
      {...rest}
    />
  )
}
