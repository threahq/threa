import * as React from "react"
import {
  useInRouterContext,
  useLocation,
  useNavigate,
  useNavigationType,
  type Location,
  type NavigateFunction,
  type NavigationType,
} from "react-router-dom"

interface HistoryBackCloseProps {
  open: boolean
  onClose: () => void
}

// Marker stored in `location.state` on the sentinel entry. Spread alongside any
// existing state so entries that carry app state (e.g. share-picker's
// `shareMeta`) keep it on the duplicated entry.
const HISTORY_OVERLAY_KEY = "__overlayBack"

function hasSentinel(state: unknown): boolean {
  return state !== null && typeof state === "object" && (state as Record<string, unknown>)[HISTORY_OVERLAY_KEY] === true
}

interface OverlayEntry {
  close: () => void
}

/**
 * Coordinates every open overlay against ONE sentinel history entry.
 *
 * Invariant: the sentinel entry exists iff at least one overlay is registered.
 * Overlays never touch history themselves — they register on open and
 * unregister on close/unmount, and `reconcile()` converges history toward the
 * invariant, one navigation at a time (`inFlight` serializes ops, because a
 * browser `history.go(-1)` settles asynchronously and a concurrent push would
 * interleave with it).
 *
 * Why one sentinel instead of one entry per overlay: overlay *handoffs* — a
 * menu drawer closing while the dialog it launched opens in the same tick
 * (sidebar footer → account drawer → status picker) — then net out to "stack
 * still non-empty", i.e. zero history operations, so there is no cross-instance
 * ordering to get wrong. The back gesture pops the sentinel; the coordinator
 * closes the top overlay and re-pushes the sentinel if others remain, so a
 * stack of overlays peels one per back press, native-style.
 */
class OverlayHistoryCoordinator {
  private stack: OverlayEntry[] = []
  private inFlight: "push" | "pop" | null = null
  private lastKey: string | null = null
  private current: Location | null = null
  navigate: NavigateFunction | null = null

  register(entry: OverlayEntry): void {
    this.stack.push(entry)
    this.reconcile()
  }

  unregister(entry: OverlayEntry): void {
    const index = this.stack.indexOf(entry)
    if (index !== -1) this.stack.splice(index, 1)
    this.reconcile()
  }

  handleLocation(location: Location, navigationType: NavigationType): void {
    // Every mounted bridge feeds every location change; dedupe by entry key.
    if (location.key === this.lastKey) return
    this.lastKey = location.key
    this.current = location
    const settledOp = this.inFlight
    this.inFlight = null

    // The back gesture consumed the sentinel (a POP we didn't issue): close the
    // top overlay in place. Removed from the stack synchronously so the
    // reconcile below re-pushes only when other overlays remain underneath.
    if (navigationType === "POP" && settledOp !== "pop" && !hasSentinel(location.state) && this.stack.length > 0) {
      const top = this.stack.pop()
      top?.close()
    }

    this.reconcile()
  }

  private reconcile(): void {
    if (this.inFlight || !this.current || !this.navigate) return
    const want = this.stack.length > 0
    const have = hasSentinel(this.current.state)
    if (want && !have) {
      this.inFlight = "push"
      this.navigate(
        { pathname: this.current.pathname, search: this.current.search, hash: this.current.hash },
        {
          state: { ...(this.current.state ?? {}), [HISTORY_OVERLAY_KEY]: true },
          preventScrollReset: true,
        }
      )
    } else if (!want && have) {
      this.inFlight = "pop"
      this.navigate(-1)
    }
  }

  resetForTests(): void {
    this.stack = []
    this.inFlight = null
    this.lastKey = null
    this.current = null
    this.navigate = null
  }
}

const coordinator = new OverlayHistoryCoordinator()

export function __resetOverlayHistoryForTests(): void {
  coordinator.resetForTests()
}

/**
 * Makes the OS back gesture close an overlay (mobile drawer, sidebar sheet)
 * instead of navigating away, matching native app behavior. UI dismissal pops
 * the sentinel entry back out, so a later back press never resurfaces a
 * dismissed overlay.
 *
 * Mount only for overlays that should behave this way (callers gate on
 * mobile). Renders nothing, and is inert outside a router (tests mount drawers
 * without one). All instances share {@link OverlayHistoryCoordinator}, so
 * stacked and handed-off overlays coordinate instead of fighting over history.
 */
export function HistoryBackClose(props: HistoryBackCloseProps) {
  const inRouter = useInRouterContext()
  if (!inRouter) return null
  return <HistoryBackCloseBridge {...props} />
}

function HistoryBackCloseBridge({ open, onClose }: HistoryBackCloseProps) {
  const location = useLocation()
  const navigate = useNavigate()
  const navigationType = useNavigationType()

  const onCloseRef = React.useRef(onClose)
  onCloseRef.current = onClose

  // Feed the coordinator before any register/unregister effect runs this
  // commit, and keep its navigate binding fresh.
  React.useEffect(() => {
    coordinator.navigate = navigate
    coordinator.handleLocation(location, navigationType)
  }, [location, navigate, navigationType])

  React.useEffect(() => {
    if (!open) return
    const entry: OverlayEntry = { close: () => onCloseRef.current() }
    coordinator.register(entry)
    return () => coordinator.unregister(entry)
  }, [open])

  return null
}
