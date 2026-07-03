import * as React from "react"
import { useInRouterContext, useLocation, useNavigate, useNavigationType } from "react-router-dom"

interface HistoryBackCloseProps {
  open: boolean
  onClose: () => void
}

// Marker stored in `location.state` on the sentinel entry an overlay pushes.
// Spread alongside any existing state so entries that carry app state (e.g.
// share-picker's `shareMeta`) keep it on the duplicated entry.
const HISTORY_OVERLAY_KEY = "__overlayBack"

function readMarker(state: unknown): string | null {
  if (state && typeof state === "object" && HISTORY_OVERLAY_KEY in state) {
    const value = (state as Record<string, unknown>)[HISTORY_OVERLAY_KEY]
    return typeof value === "string" ? value : null
  }
  return null
}

/**
 * Makes the OS back gesture close an overlay (mobile drawer, sheet) instead of
 * navigating away, matching native app behavior.
 *
 * Opening pushes a same-URL history entry tagged with this instance's id in
 * `location.state`; the back gesture pops that entry, we see our marker vanish
 * and call `onClose`. Closing through the UI (swipe-down, backdrop, action)
 * pops the sentinel entry so a later back press doesn't resurface a location
 * the user already dismissed.
 *
 * Mount only for overlays that should behave this way (the caller gates on
 * mobile). Renders nothing, and is inert outside a router (tests mount drawers
 * without one).
 */
export function HistoryBackClose(props: HistoryBackCloseProps) {
  const inRouter = useInRouterContext()
  if (!inRouter) return null
  return <HistoryBackCloseBridge {...props} />
}

function HistoryBackCloseBridge({ open, onClose }: HistoryBackCloseProps) {
  const id = React.useId()
  const location = useLocation()
  const navigate = useNavigate()
  const navigationType = useNavigationType()

  // Sentinel entry lifecycle: "pushing" between navigate() and the location
  // update landing, "landed" once our marker is current, "popPending" when the
  // overlay closed while our sentinel isn't current yet (closed before the
  // push landed, or a stacked overlay's pop is still in flight) — pop it the
  // moment it becomes current. A ref, not state — transitions must be visible
  // synchronously across the two effects below and must survive StrictMode's
  // double effect invocation.
  const phaseRef = React.useRef<"idle" | "pushing" | "landed" | "popPending">("idle")
  const locationRef = React.useRef(location)
  locationRef.current = location
  const onCloseRef = React.useRef(onClose)
  onCloseRef.current = onClose
  const navigateRef = React.useRef(navigate)
  navigateRef.current = navigate

  React.useEffect(() => {
    const current = locationRef.current
    if (open && (phaseRef.current === "idle" || phaseRef.current === "popPending")) {
      // A popPending sentinel that never resurfaced (e.g. it was clobbered by a
      // replace navigation) must not block a fresh open — push a new one.
      phaseRef.current = "pushing"
      navigateRef.current(
        { pathname: current.pathname, search: current.search, hash: current.hash },
        { state: { ...(current.state ?? {}), [HISTORY_OVERLAY_KEY]: id }, preventScrollReset: true }
      )
    } else if (!open && phaseRef.current === "pushing") {
      phaseRef.current = "popPending"
    } else if (!open && phaseRef.current === "landed") {
      if (readMarker(current.state) === id) {
        phaseRef.current = "idle"
        navigateRef.current(-1)
      } else {
        // A stacked overlay above us is mid-pop (both closed in one tick);
        // our sentinel surfaces once that pop lands, and we pop it then.
        phaseRef.current = "popPending"
      }
    }
  }, [open, id])

  React.useEffect(() => {
    const marker = readMarker(location.state)
    if (marker === id) {
      if (phaseRef.current === "pushing") {
        phaseRef.current = "landed"
      } else if (phaseRef.current === "popPending") {
        phaseRef.current = "idle"
        navigateRef.current(-1)
      }
      return
    }
    // Our marker vanished on a back/forward traversal: the back gesture popped
    // the sentinel — close the overlay. Only POP counts: a forward push with a
    // different marker (a drawer stacking on top of us, an in-page navigation)
    // leaves our sentinel in place behind it and must not close us.
    if (phaseRef.current === "landed" && navigationType === "POP") {
      phaseRef.current = "idle"
      onCloseRef.current()
    }
  }, [location, navigationType, id])

  // Unmounting while our sentinel is current would leave a stale duplicate
  // entry, making the next back press a visual no-op; pop it.
  React.useEffect(
    () => () => {
      if (phaseRef.current === "landed" && readMarker(locationRef.current.state) === id) {
        phaseRef.current = "idle"
        navigateRef.current(-1)
      }
    },
    [id]
  )

  return null
}
