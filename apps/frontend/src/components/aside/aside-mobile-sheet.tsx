import {
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react"
import { HistoryBackClose } from "@/components/ui/history-back-close"
import { useStreamName } from "@/hooks/use-stream-name"
import { cn } from "@/lib/utils"
import { closeAside, setAsideSurface, type AsideSurface } from "@/stores/aside-store"
import { AsidePane } from "./aside-pane"
import {
  ASIDE_PEEK_FRACTION,
  ASIDE_TAB_HEIGHT,
  asideMobileHeight,
  nearestAsideSurface,
  steppedAsideSurface,
} from "./aside-mobile-snap"

interface AsideMobileSheetProps {
  workspaceId: string
  asideId: string
  hostStreamId: string
  originScope: string
  /** `dock` is the peek, `fullscreen` the whole viewport; minimized never renders here. */
  surface: Exclude<AsideSurface, "minimized">
}

const REDUCED_MOTION =
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true

function viewportHeight(): number {
  return window.visualViewport?.height ?? window.innerHeight
}

/** A drag would fight the on-screen keyboard, so a focused composer wins: the tap blurs it instead. */
function composerHasFocus(sheet: HTMLElement | null): boolean {
  const active = document.activeElement
  return active instanceof HTMLElement && !!sheet?.contains(active) && active.isContentEditable
}

/**
 * The aside on a phone: a sheet over the host that peeks at 45% of the
 * viewport, pulls up to the whole of it, and drags down to the strip above the
 * composer. The context strip doubles as the drag handle — the aside's own
 * chrome is the affordance, so nothing has to tell you to pull it.
 */
export function AsideMobileSheet({ workspaceId, asideId, hostStreamId, originScope, surface }: AsideMobileSheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null)
  const [dragHeight, setDragHeight] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{
    startY: number
    startHeight: number
    height: number
    velocity: number
    lastY: number
    lastT: number
  } | null>(null)
  const hostName = useStreamName(workspaceId, hostStreamId, "breadcrumb")

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (composerHasFocus(sheetRef.current)) return
    // The handle carries text; without this a drag starts a text selection and
    // the browser cancels the pointer stream mid-gesture, so the sheet snaps
    // back to where it started.
    event.preventDefault()
    const startHeight = sheetRef.current?.getBoundingClientRect().height ?? asideMobileHeight(surface, viewportHeight())
    drag.current = {
      startY: event.clientY,
      startHeight,
      height: startHeight,
      velocity: 0,
      lastY: event.clientY,
      lastT: performance.now(),
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragHeight(startHeight)
    setDragging(true)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current
    if (!state) return
    const now = performance.now()
    // Bottom-anchored: the sheet grows as the pointer moves UP, so the delta is inverted.
    const next = Math.min(
      Math.max(state.startHeight - (event.clientY - state.startY), ASIDE_TAB_HEIGHT),
      viewportHeight()
    )
    const dt = now - state.lastT
    if (dt > 0) state.velocity = -(event.clientY - state.lastY) / dt
    state.lastY = event.clientY
    state.lastT = now
    state.height = next
    setDragHeight(next)
  }

  const onPointerUp = () => {
    const state = drag.current
    drag.current = null
    setDragging(false)
    setDragHeight(null)
    if (!state) return
    // A pause before release means the drag stopped — don't flick on stale velocity.
    const velocity = performance.now() - state.lastT > 120 ? 0 : state.velocity
    setAsideSurface(nearestAsideSurface(state.height, velocity, viewportHeight()))
  }

  // The drag is the primary gesture, but it is a pointer gesture: the handle is
  // a focusable separator so a keyboard reaches the same three detents.
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return
    const direction = event.key === "ArrowUp" ? 1 : -1
    event.preventDefault()
    setAsideSurface(steppedAsideSurface(surface, direction))
  }

  const restingHeight = surface === "fullscreen" ? "100dvh" : `${ASIDE_PEEK_FRACTION * 100}dvh`
  const height = dragging && dragHeight != null ? `${dragHeight}px` : restingHeight

  return (
    <>
      <HistoryBackClose open onClose={closeAside} />
      <div
        ref={sheetRef}
        data-testid="aside-sheet"
        data-surface={surface}
        data-suppress-pull-refresh="true"
        className={cn(
          "absolute inset-x-0 bottom-0 z-30 flex flex-col overflow-hidden rounded-t-xl border-t-2 border-primary/70 bg-background shadow-lg",
          !dragging && !REDUCED_MOTION && "transition-[height] duration-200 ease-out"
        )}
        style={{ height }}
      >
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize aside"
          aria-valuetext={surface === "fullscreen" ? "Full screen" : "Peek"}
          tabIndex={0}
          data-testid="aside-sheet-handle"
          onKeyDown={onKeyDown}
          className="flex shrink-0 touch-none select-none items-center gap-2 px-3 py-2"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <span aria-hidden className="h-1 w-8 shrink-0 rounded-full bg-muted-foreground/40" />
          {/* Where the aside sits, not what it is — the pane header below carries
              its title and the way out, so the handle stays one line of context. */}
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{hostName ?? ""}</span>
        </div>
        <div className="min-h-0 flex-1">
          <AsidePane
            workspaceId={workspaceId}
            asideId={asideId}
            hostStreamId={hostStreamId}
            originScope={originScope}
            surface={surface}
            takeover
          />
        </div>
      </div>
    </>
  )
}
