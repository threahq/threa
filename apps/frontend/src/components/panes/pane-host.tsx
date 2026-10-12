import { createContext, useContext, type HTMLAttributes, type Ref, type RefObject } from "react"
import { cn } from "@/lib/utils"
import { usePaneGlide } from "./pane-glide"

interface PaneHostProps extends HTMLAttributes<HTMLDivElement> {
  /** `grid-template-columns` for the docked arrangement. */
  columns: string
  /** `grid-template-rows`: the panel sections' row tracks. */
  rows: string
  /** Whether this render changes the arrangement, so the panes glide into it rather than jump. */
  glide: boolean
  ref: RefObject<HTMLDivElement | null>
}

/**
 * One grid holding every pane of a page as a flat child. Arrangement changes
 * restyle the panes in place; a pane never moves to another parent, because
 * React would remount it and its scroll offset, draft and focus would go.
 * Overlays a page anchors to this row (`absolute inset-0`) stop at the sidebar.
 */
export function PaneHost({ columns, rows, glide, className, style, ref, ...rest }: PaneHostProps) {
  usePaneGlide(ref, glide)
  return (
    <div
      ref={ref}
      className={cn("relative grid h-full min-h-0", className)}
      style={{ ...style, gridTemplateColumns: columns, gridTemplateRows: rows }}
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
