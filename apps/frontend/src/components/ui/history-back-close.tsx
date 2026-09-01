import * as React from "react"
import type { Location, NavigationType, createMemoryRouter } from "react-router-dom"

/** Any react-router data router (browser or memory) — same object shape. */
type DataRouter = ReturnType<typeof createMemoryRouter>

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
 *
 * Ground truth is `router.state` (attached via {@link attachOverlayHistoryRouter}),
 * NEVER a React-committed location — for what it reads AND for how it hears
 * about a navigation, which is why the feed is `router.subscribe` rather than
 * an effect on `useLocation()`. Router navigations run inside
 * `startTransition`, and a transition renders as often as React likes while
 * committing only once it wins: with a phone's aside sheet mounted, that
 * commit can be starved for seconds, and a coordinator listening for it goes
 * deaf mid-session — the back gesture then walks the real history down with
 * nothing closing, until the app runs out of entries and exits. Deciding a pop
 * against the same lag is how "tap a sidebar link → the coordinator pops the
 * sentinel it still thinks is current → the pop lands after the navigation and
 * reverts it" broke ALL mobile navigation. `router.state.location` updates in
 * lockstep with history, and `router.state.navigation.state` exposes in-flight
 * transitions so reconcile can wait them out instead of guessing.
 */
class OverlayHistoryCoordinator {
  private stack: OverlayEntry[] = []
  private inFlight: "push" | "pop" | null = null
  private reconcileScheduled = false
  // The entry a sentinel WE pushed settled on, and only while we are still
  // standing on it: any other committed location clears it. reconcile() pops
  // that entry and no other — a marker restored from a reloaded session is
  // inert data, and so is one we pushed, left by navigating on with the
  // overlay open, and later came back to. Popping that one spends two entries
  // on one back press, which is how a phone reaches the bottom of its history
  // — and closes the app — a navigation early.
  private sentinelKey: string | null = null
  private lastKey: string | null = null
  private router: DataRouter | null = null
  private unsubscribe: (() => void) | null = null

  attachRouter(router: DataRouter): void {
    if (this.router === router) return
    this.unsubscribe?.()
    this.router = router
    this.lastKey = router.state.location.key
    this.unsubscribe = router.subscribe((state) => this.handleLocation(state.location, state.historyAction))
  }

  register(entry: OverlayEntry): void {
    this.stack.push(entry)
    this.scheduleReconcile()
  }

  unregister(entry: OverlayEntry): void {
    const index = this.stack.indexOf(entry)
    if (index !== -1) this.stack.splice(index, 1)
    this.scheduleReconcile()
  }

  /** Fed every location the router commits, by the subscription in {@link attachRouter}. */
  handleLocation(location: Location, navigationType: NavigationType): void {
    if (location.key === this.lastKey) return
    this.lastKey = location.key
    const settledOp = this.inFlight
    this.inFlight = null
    this.sentinelKey = settledOp === "push" ? location.key : null

    // The back gesture consumed the sentinel (a POP we didn't issue): close the
    // top overlay in place. Removed from the stack synchronously so the
    // reconcile below re-pushes only when other overlays remain underneath.
    if (navigationType === "POP" && settledOp !== "pop" && !hasSentinel(location.state) && this.stack.length > 0) {
      const top = this.stack.pop()
      top?.close()
    }

    this.scheduleReconcile()
  }

  // Reconcile on a microtask, never synchronously: within a commit, effect
  // cleanups (an overlay's unregister) run before effect creates, so acting
  // immediately would interleave with the same commit's other work.
  private scheduleReconcile(): void {
    if (this.reconcileScheduled) return
    this.reconcileScheduled = true
    queueMicrotask(() => {
      this.reconcileScheduled = false
      this.reconcile()
    })
  }

  private reconcile(): void {
    const router = this.router
    if (!router || this.inFlight) return
    // A navigation is mid-flight (e.g. a lazy route chunk loading): decide
    // nothing against a moving target. Its completion commits a location,
    // which re-feeds handleLocation and reschedules this reconcile.
    if (router.state.navigation.state !== "idle") return
    const location = router.state.location
    const want = this.stack.length > 0
    const have = hasSentinel(location.state)
    if (want && !have) {
      this.inFlight = "push"
      void router.navigate(
        { pathname: location.pathname, search: location.search, hash: location.hash },
        {
          state: { ...(location.state ?? {}), [HISTORY_OVERLAY_KEY]: true },
          preventScrollReset: true,
        }
      )
    } else if (!want && have && this.sentinelKey === location.key) {
      this.inFlight = "pop"
      void router.navigate(-1)
    }
  }

  resetForTests(): void {
    this.stack = []
    this.inFlight = null
    this.sentinelKey = null
    this.lastKey = null
    this.unsubscribe?.()
    this.unsubscribe = null
    this.router = null
    // A microtask scheduled before the reset may still fire; reconcile() is a
    // no-op with the router cleared.
  }
}

const coordinator = new OverlayHistoryCoordinator()

/**
 * Hand the coordinator its data router. Called once at router creation
 * (`routes/index.tsx`); tests attach their memory router the same way.
 * Without an attached router the coordinator is inert, so drawers mounted in
 * router-less unit tests keep working untouched.
 */
export function attachOverlayHistoryRouter(router: DataRouter): void {
  coordinator.attachRouter(router)
}

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
 * mobile). Renders nothing; registration is its only job — history is handled
 * by the shared {@link OverlayHistoryCoordinator}.
 */
export function HistoryBackClose({ open, onClose }: HistoryBackCloseProps) {
  const onCloseRef = React.useRef(onClose)
  onCloseRef.current = onClose

  React.useEffect(() => {
    if (!open) return
    const entry: OverlayEntry = { close: () => onCloseRef.current() }
    coordinator.register(entry)
    return () => coordinator.unregister(entry)
  }, [open])

  return null
}
