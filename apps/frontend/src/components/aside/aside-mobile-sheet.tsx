import {
  useEffect,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react"
import { HistoryBackClose } from "@/components/ui/history-back-close"
import { cn } from "@/lib/utils"
import { closeAside, setAsideSheetDetent, useAsideOpenDraft, useAsideSheetDetent } from "@/stores/aside-store"
import { AsidePane } from "./aside-pane"
import {
  ASIDE_PEEK_FRACTION,
  ASIDE_DISMISS_HEIGHT,
  asideMobileHeight,
  nearestAsideDetent,
  steppedAsideDetent,
  type AsideDetent,
} from "./aside-mobile-snap"

interface AsideMobileSheetProps {
  workspaceId: string
  asideId: string
  hostStreamId: string
  originScope: string
}

const REDUCED_MOTION =
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true

const SETTLE_MS = 200

function viewportHeight(): number {
  return window.visualViewport?.height ?? window.innerHeight
}

function isEditorTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.isContentEditable
}

/**
 * The aside on a phone: a sheet over the host that peeks at 45% of the
 * viewport, pulls up to the whole of it, and drags down off the bottom to
 * leave. The handle carries nothing but the grab pill: every row above the
 * conversation is a row of it the reader doesn't get, and the pane's own
 * anchor line already says which stream this sits beside.
 */
export function AsideMobileSheet({ workspaceId, asideId, hostStreamId, originScope }: AsideMobileSheetProps) {
  const detent = useAsideSheetDetent()
  const sheetRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  // The height eases only on the way from a gesture to its detent. Viewport
  // changes — the keyboard, mostly — must land instantly: dvh re-resolves in
  // steps as the keyboard animates, and easing each step left the sheet
  // taller than the viewport on the way up and shorter on the way down.
  const [settling, setSettling] = useState(false)
  useEffect(() => {
    if (!settling) return
    const timer = window.setTimeout(() => setSettling(false), SETTLE_MS)
    return () => window.clearTimeout(timer)
  }, [settling])
  // Writing takes the sheet over: the keyboard takes the bottom of the
  // viewport, and a 45% peek of what is left is chrome and two lines. The
  // sheet moves to the full detent and stays there — a real state change a
  // drag can undo, not a presentation the sheet undoes for you. Rising on
  // focus and falling back on blur put a resize on both edges of every
  // keyboard, two heights and a viewport moving at once, and it showed.
  const onFocusCapture = (event: ReactFocusEvent<HTMLDivElement>) => {
    if (isEditorTarget(event.target)) setAsideSheetDetent("full")
  }
  const drag = useRef<{
    startY: number
    startHeight: number
    height: number
    velocity: number
    lastY: number
    lastT: number
  } | null>(null)
  // Opening a draft takes the sheet over in its own right, ahead of the focus
  // its editor then takes.
  const openDraft = useAsideOpenDraft(asideId)
  useEffect(() => {
    if (openDraft) setAsideSheetDetent("full")
  }, [openDraft])

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // Without this the browser turns the drag into a text selection and
    // cancels the pointer stream mid-gesture, so the sheet snaps back to where
    // it started. It also keeps focus — and the keyboard — in an editor that
    // has it: a drag never closes the keyboard.
    event.preventDefault()
    const startHeight = sheetRef.current?.getBoundingClientRect().height ?? asideMobileHeight(detent, viewportHeight())
    drag.current = {
      startY: event.clientY,
      startHeight,
      height: startHeight,
      velocity: 0,
      lastY: event.clientY,
      lastT: performance.now(),
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragging(true)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current
    if (!state) return
    const now = performance.now()
    // Bottom-anchored: the sheet grows as the pointer moves UP, so the delta is inverted.
    const next = Math.min(
      Math.max(state.startHeight - (event.clientY - state.startY), ASIDE_DISMISS_HEIGHT),
      viewportHeight()
    )
    const dt = now - state.lastT
    if (dt > 0) state.velocity = -(event.clientY - state.lastY) / dt
    state.lastY = event.clientY
    state.lastT = now
    state.height = next
    // Written straight to the node, not through state: a render per pointermove
    // re-renders the pane — a whole timeline — on every frame of the gesture,
    // and that is the drag's jank. React owns the resting height; the gesture
    // owns the node for as long as it holds the pointer.
    if (sheetRef.current) sheetRef.current.style.height = `${next}px`
  }

  // The browser took the pointer (a scroll, a system gesture): the drag never
  // finished, so nothing is committed — the sheet settles back where it was.
  const onPointerCancel = () => {
    drag.current = null
    setDragging(false)
  }

  const onPointerUp = () => {
    const state = drag.current
    drag.current = null
    setDragging(false)
    if (!state) return
    // A pause before release means the drag stopped — don't flick on stale velocity.
    const velocity = performance.now() - state.lastT > 120 ? 0 : state.velocity
    settle(nearestAsideDetent(state.height, velocity, viewportHeight()))
  }

  // Dragging (or arrowing) below the smallest reading surface dismisses: an
  // aside is left, not parked, and its anchor row in the timeline is the way
  // back in.
  const settle = (next: AsideDetent) => {
    if (next === "closed") return closeAside()
    setSettling(true)
    setAsideSheetDetent(next)
  }

  // The drag is the primary gesture, but it is a pointer gesture: the handle is
  // a focusable separator so a keyboard reaches the same three detents.
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return
    const direction = event.key === "ArrowUp" ? 1 : -1
    event.preventDefault()
    // The keyboard resizes; it does not dismiss. A drag to the floor is a
    // deliberate throw-away gesture, an arrow press is not — the header's close
    // is how a keyboard leaves.
    const next = steppedAsideDetent(detent, direction)
    if (next !== "closed") settle(next)
  }

  const restingHeight = detent === "full" ? "100dvh" : `${ASIDE_PEEK_FRACTION * 100}dvh`
  // Read from the drag rather than state: an unrelated re-render mid-gesture
  // must re-apply the height the node already has, not the one the drag
  // started on.
  const height = dragging && drag.current ? `${drag.current.height}px` : restingHeight

  return (
    <>
      <HistoryBackClose open onClose={closeAside} />
      <div
        ref={sheetRef}
        data-testid="aside-sheet"
        data-detent={detent}
        onFocusCapture={onFocusCapture}
        data-suppress-pull-refresh="true"
        className={cn(
          "absolute inset-x-0 bottom-0 z-30 flex flex-col overflow-hidden rounded-t-xl border-t-2 border-primary/70 bg-background shadow-lg",
          settling && !dragging && !REDUCED_MOTION && "transition-[height] duration-200 ease-out"
        )}
        style={{ height }}
      >
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize aside"
          aria-valuemin={1}
          aria-valuemax={2}
          aria-valuenow={detent === "full" ? 2 : 1}
          aria-valuetext={detent === "full" ? "Full screen" : "Peek"}
          tabIndex={0}
          data-testid="aside-sheet-handle"
          onKeyDown={onKeyDown}
          className="flex shrink-0 touch-none select-none items-center justify-center py-2"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
        >
          <span aria-hidden className="h-1 w-9 rounded-full bg-muted-foreground/40" />
        </div>
        <div className="min-h-0 flex-1">
          <AsidePane
            workspaceId={workspaceId}
            asideId={asideId}
            hostStreamId={hostStreamId}
            originScope={originScope}
          />
        </div>
      </div>
    </>
  )
}
