import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { cn } from "@/lib/utils"
import { useIsMobile } from "@/hooks/use-mobile"
import { useResizeDrag } from "@/hooks/use-resize-drag"
import { PanelResizeHandle } from "@/components/layout"
import {
  ASIDE_DOCK_DEFAULT_WIDTH,
  ASIDE_DOCK_MIN_WIDTH,
  setAsideDockWidth,
  useAsideDockWidth,
  useAsideForHost,
  type OpenAsideState,
} from "@/stores/aside-store"
import { AsidePane } from "./aside-pane"
import { AsideMobileSheet } from "./aside-mobile-sheet"
import { AsideMinimizedStrip } from "./aside-minimized-strip"

export const ASIDE_DOCK_WIDTH = ASIDE_DOCK_DEFAULT_WIDTH
// What the host stream keeps for itself: below this its timeline and composer
// stop being a place you can read the thing you are writing about. The dock
// yields to it, which is what caps the drag on a narrow window.
const MIN_HOST_WIDTH = 420
// Matches the thread panel slot (`duration-200`): the dock folds shut on the
// same clock the panel slides on, so the two right-edge surfaces never drift.
const FOLD_MS = 200

/**
 * The dock's width snaps to zero through a CSS transition on close; the pane
 * stays mounted for that one beat so the fold has content to clip, then
 * unmounts. A surface switch (dock ⇄ fullscreen) swaps in place.
 */
function useFoldingState(current: OpenAsideState | null): OpenAsideState | null {
  const [rendered, setRendered] = useState(current)
  useEffect(() => {
    if (current) {
      setRendered(current)
      return
    }
    const timer = window.setTimeout(() => setRendered(null), FOLD_MS)
    return () => window.clearTimeout(timer)
  }, [current])
  return current ?? rendered
}

/**
 * Width of the row the slot sits in, so the drag can be capped against what is
 * actually on screen rather than the viewport. Measured off the parent because
 * the slot IS the thing being resized. Re-measures when the slot mounts a
 * surface (`mounted`) — a ref alone would never re-run the effect.
 */
function useRowWidth(ref: React.RefObject<HTMLDivElement | null>, mounted: boolean): number {
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const parent = ref.current?.parentElement
    if (!parent) return
    const measure = () => setWidth(parent.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(parent)
    return () => observer.disconnect()
  }, [ref, mounted])
  return width
}

interface AsideDockSlotProps {
  workspaceId: string
  hostKey: string
}

/**
 * The aside's reading surfaces, mounted as the last flex child of a page's
 * content row — after the thread panel slot, so the aside owns the page's
 * right edge (calls own the app's). Dock pushes the host by ASIDE_DOCK_WIDTH;
 * fullscreen takes half the row with the live host timeline on the left. On a
 * phone the dock is a plain takeover of the content area (PR7 owns the real
 * mobile surface). Renders nothing while the aside is minimized or closed.
 */
export function AsideDockSlot({ workspaceId, hostKey }: AsideDockSlotProps) {
  const current = useAsideForHost(hostKey)
  const reading = current && current.surface !== "minimized" ? current : null
  const rendered = useFoldingState(reading)
  const isMobile = useIsMobile()
  const slotRef = useRef<HTMLDivElement>(null)
  const rowWidth = useRowWidth(slotRef, rendered !== null)
  const storedWidth = useAsideDockWidth(rendered?.asideId ?? null)
  // The cap follows the window: a narrower row (a collapsed sidebar coming
  // back, a smaller window) re-clamps the stored width without touching it, so
  // widening the window restores what the user dragged. Before the first
  // measurement the viewport stands in — capping at the stored width instead
  // would make the handle inert on the frame the user grabs it.
  const measuredRow = rowWidth > 0 ? rowWidth : (globalThis.window?.innerWidth ?? 0)
  const maxWidth = Math.max(ASIDE_DOCK_MIN_WIDTH, measuredRow - MIN_HOST_WIDTH)
  const dockWidth = Math.min(Math.max(storedWidth, ASIDE_DOCK_MIN_WIDTH), maxWidth)
  const asideId = rendered?.asideId ?? null
  const applyWidth = useCallback(
    (next: number) => {
      if (!asideId) return
      setAsideDockWidth(asideId, Math.min(Math.max(next, ASIDE_DOCK_MIN_WIDTH), maxWidth))
    },
    [asideId, maxWidth]
  )
  const { isResizing, handleResizeStart, handleResizeMove, handleResizeEnd } = useResizeDrag({
    width: dockWidth,
    onWidthChange: applyWidth,
    direction: "left",
  })
  const handleResizeKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const step = event.shiftKey ? 50 : 10
      if (event.key === "ArrowLeft") {
        event.preventDefault()
        applyWidth(dockWidth + step)
      } else if (event.key === "ArrowRight") {
        event.preventDefault()
        applyWidth(dockWidth - step)
      }
    },
    [applyWidth, dockWidth]
  )

  // On a phone the parked strip is this slot's too: the page's main column is
  // invisible and inert under a panel takeover, so a strip inside it would
  // vanish with the aside the moment it was parked from a thread or
  // conversation panel. Here it sits over whichever surface is showing.
  if (isMobile && current?.surface === "minimized") {
    return <AsideMinimizedStrip workspaceId={workspaceId} hostKey={hostKey} overlay />
  }

  if (!rendered) return null
  const surface = rendered.surface === "fullscreen" ? "fullscreen" : "dock"

  if (isMobile) {
    // The sheet owns its own drag-to-resize, so a fold animation here would
    // fight it; it simply unmounts with the aside.
    if (!reading) return null
    return (
      <AsideMobileSheet
        workspaceId={workspaceId}
        asideId={rendered.asideId}
        hostStreamId={rendered.hostStreamId}
        originScope={rendered.originScope}
        surface={surface}
      />
    )
  }

  const open = reading !== null
  const docked = surface === "dock"

  let width: number | undefined = 0
  if (open) width = docked ? dockWidth : undefined
  return (
    <div
      ref={slotRef}
      data-testid="aside-dock"
      data-surface={surface}
      className={cn(
        "flex-shrink-0 overflow-hidden border-l",
        // No width transition while dragging — the handle sets the width every
        // frame, and an eased transition would trail the pointer.
        !isResizing && "transition-[width] duration-200 ease-out",
        // Half the row: a fixed basis, so the host's `flex-1` takes the other half.
        surface === "fullscreen" && open && "basis-1/2"
      )}
      style={{ width }}
    >
      <div className="flex h-full" style={{ minWidth: docked ? dockWidth : undefined }}>
        {docked && (
          <PanelResizeHandle
            isResizing={isResizing}
            panelWidth={dockWidth}
            minWidth={ASIDE_DOCK_MIN_WIDTH}
            maxWidth={maxWidth}
            onPointerDown={handleResizeStart}
            onPointerMove={handleResizeMove}
            onPointerEnd={handleResizeEnd}
            onKeyDown={handleResizeKeyDown}
            ariaLabel="Resize aside"
          />
        )}
        <div className="min-w-0 flex-1">
          <AsidePane
            workspaceId={workspaceId}
            asideId={rendered.asideId}
            hostStreamId={rendered.hostStreamId}
            originScope={rendered.originScope}
            surface={surface}
          />
        </div>
      </div>
    </div>
  )
}
