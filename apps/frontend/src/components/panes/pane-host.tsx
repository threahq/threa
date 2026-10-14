import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
} from "react"
import { flushSync } from "react-dom"
import { cn } from "@/lib/utils"
import { paneLanding, usePaneGlide } from "./pane-glide"

interface PaneHostProps extends HTMLAttributes<HTMLDivElement> {
  /** `grid-template-columns` for the docked arrangement. */
  columns: string
  /** `grid-template-rows`: the panel sections' row tracks. */
  rows: string
  /** Whether this render changes the arrangement, so the panes glide into it rather than jump. */
  glide: boolean
  /** Whether that change adds or removes a pane slot. Only then can an added pane land amid moving ones. */
  reshapes: boolean
  ref: RefObject<HTMLDivElement | null>
}

/**
 * One grid holding every pane of a page as a flat child. Arrangement changes
 * restyle the panes in place; a pane never moves to another parent, because
 * React would remount it and its scroll offset, draft and focus would go.
 * Overlays a page anchors to this row (`absolute inset-0`) stop at the sidebar.
 */
export function PaneHost({ columns, rows, glide, reshapes, className, style, ref, ...rest }: PaneHostProps) {
  usePaneGlide(ref, glide)
  return (
    <PaneGlideContext.Provider value={reshapes}>
      <div
        ref={ref}
        className={cn("relative grid h-full min-h-0", className)}
        style={{ ...style, gridTemplateColumns: columns, gridTemplateRows: rows }}
        {...rest}
      />
    </PaneGlideContext.Provider>
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
}

const PaneGlideContext = createContext(false)
const PaneCoveredContext = createContext(false)
const PaneLandedContext = createContext(true)

/**
 * Whether the pane this renders in, or any pane around it, is covered. A covered
 * pane keeps its geometry, so what reads "on screen" from layout (the read
 * frontier) has to ask this instead.
 */
export function usePaneCovered(): boolean {
  return useContext(PaneCoveredContext)
}

/**
 * Shows `fallback` while the glide that brought this pane in is still running, `children` once it lands.
 * Heavy content waits for it: mounting a timeline in the commit that starts the glide delays the glide's first
 * frame by the whole mount. Only this gate re-renders on landing, not the pane around it.
 */
export function PaneLanded({ fallback, children }: { fallback: ReactNode; children: ReactNode }) {
  return useContext(PaneLandedContext) ? children : fallback
}

export function Pane({ area, covered = false, inert = false, className, style, ...rest }: PaneProps) {
  // Out of reach is out of sight: a pane under a floating one shows through the scrim but is not being read.
  const hidden = usePaneCovered() || covered || inert
  const ref = useRef<HTMLDivElement>(null)
  const [landed, setLanded] = useState(!useContext(PaneGlideContext))
  useLayoutEffect(() => {
    if (landed) return
    let live = true
    // The host starts the glide in its own layout effect, after this one. A microtask runs once it has and
    // still before paint, so a pane nothing glides shows its content in the frame it mounts in.
    queueMicrotask(() => {
      const landing = live && ref.current ? paneLanding(ref.current) : null
      if (!live) return
      if (!landing) flushSync(() => setLanded(true))
      else
        void landing.then(() => {
          if (live) setLanded(true)
        })
    })
    return () => {
      live = false
    }
  }, [landed])
  return (
    <PaneCoveredContext.Provider value={hidden}>
      <PaneLandedContext.Provider value={landed}>
        <div
          ref={ref}
          className={cn("min-h-0 min-w-0 overflow-hidden", covered && "invisible", className)}
          style={{ ...style, gridArea: area }}
          inert={covered || inert || undefined}
          {...rest}
        />
      </PaneLandedContext.Provider>
    </PaneCoveredContext.Provider>
  )
}
