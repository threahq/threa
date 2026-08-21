import { useEffect, useState } from "react"
import { cn } from "@/lib/utils"
import { useIsMobile } from "@/hooks/use-mobile"
import { useAsideForHost, type OpenAsideState } from "@/stores/aside-store"
import { AsidePane } from "./aside-pane"

export const ASIDE_DOCK_WIDTH = 400
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

  if (!rendered) return null
  const surface = rendered.surface === "fullscreen" ? "fullscreen" : "dock"

  if (isMobile) {
    return (
      <div
        data-testid="aside-dock"
        data-surface="takeover"
        className="absolute inset-0 z-30 flex flex-col bg-background"
      >
        <AsidePane workspaceId={workspaceId} asideId={rendered.asideId} surface={surface} takeover />
      </div>
    )
  }

  const open = reading !== null
  let width: number | undefined = 0
  if (open) width = surface === "fullscreen" ? undefined : ASIDE_DOCK_WIDTH
  return (
    <div
      data-testid="aside-dock"
      data-surface={surface}
      className={cn(
        "flex-shrink-0 overflow-hidden border-l transition-[width] duration-200 ease-out",
        surface === "fullscreen" && open && "flex-1 basis-1/2"
      )}
      style={{ width }}
    >
      <div className="h-full" style={{ minWidth: surface === "fullscreen" ? undefined : ASIDE_DOCK_WIDTH }}>
        <AsidePane workspaceId={workspaceId} asideId={rendered.asideId} surface={surface} />
      </div>
    </div>
  )
}
