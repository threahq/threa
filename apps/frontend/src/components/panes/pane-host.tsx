import { createContext, useContext, type HTMLAttributes, type Ref } from "react"
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
  /** `grid-area` of the pane's cell. Panes sharing a cell stack, and only one is shown. */
  area: string
  /**
   * Covered by another pane in the same cell. `visibility`, never `display`:
   * the box, and with it the scroll offset, has to survive being hidden.
   */
  covered?: boolean
  inert?: boolean
  ref?: Ref<HTMLDivElement>
}

const PaneCoveredContext = createContext(false)

/**
 * Whether the pane this renders in, or any pane around it, is covered. A covered
 * pane keeps its geometry, so what reads "on screen" from layout (the read
 * frontier) has to ask this instead.
 */
export function usePaneCovered(): boolean {
  return useContext(PaneCoveredContext)
}

export function Pane({ area, covered = false, inert = false, className, style, ...rest }: PaneProps) {
  // Out of reach is out of sight: a pane under a floating one shows through the scrim but is not being read.
  const hidden = usePaneCovered() || covered || inert
  return (
    <PaneCoveredContext.Provider value={hidden}>
      <div
        className={cn("min-h-0 min-w-0 overflow-hidden", covered && "invisible", className)}
        style={{ ...style, gridArea: area }}
        inert={covered || inert || undefined}
        {...rest}
      />
    </PaneCoveredContext.Provider>
  )
}
