import * as React from "react"
import type { Location, NavigationType, createMemoryRouter } from "react-router-dom"

/** Any react-router data router (browser or memory) — same object shape. */
type DataRouter = ReturnType<typeof createMemoryRouter>

interface HistoryBackCloseProps {
  open: boolean
  onClose: () => void
}

interface OverlayEntry {
  close: () => void
}

/**
 * Gives every open overlay one history entry of its own, so the back gesture
 * closes overlays one per press, native-style, and the app's own URL entries
 * (`?panel=`, `?media=`) interleave with them in the order they were opened.
 *
 * Overlays never touch history themselves — they register on open and
 * unregister on close/unmount — and `reconcile()` converges the number of
 * sentinel entries we own toward the number of open overlays, one navigation
 * at a time (`inFlight` serializes ops, because a browser `history.go(-1)`
 * settles asynchronously and a concurrent push would interleave with it).
 * Overlay *handoffs* — a menu drawer closing while the dialog it launched
 * opens in the same tick — net out to the same depth, so they cost nothing.
 *
 * The one rule that matters on a phone: NEVER push after a back. Chrome marks
 * every same-document entry skippable when a `pushState` follows a
 * browser-initiated back without a user activation in between, and Android's
 * back then skips them all and leaves the app. So a back that lands under one
 * of our entries closes its overlay and forgets the entry; a back that lands
 * ON one of our entries (an app entry above it was popped — the URL closes
 * what it opened) changes nothing, and the next press closes that overlay.
 * An entry left behind by an overlay that closed while navigating on (the
 * actions drawer whose "Reply in thread" pushes `?panel=`) stays counted, so
 * no fresh entry is pushed for it, and is popped the moment a back lands on
 * it — a pop, never a push. Leaving the pathname forgets every entry: the
 * overlays are gone with the page, and the entries are ordinary back presses.
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
  // Keys of the entries we pushed and still account for, bottom to top. Only
  // the count and the top matter: a back that leaves the top entry closes the
  // top overlay. Keys survive a reload only as history state, and a reloaded
  // session starts with none — those entries are inert data.
  private sentinelKeys: string[] = []
  private lastKey: string | null = null
  private lastPathname: string | null = null
  private router: DataRouter | null = null
  private unsubscribe: (() => void) | null = null

  attachRouter(router: DataRouter): void {
    if (this.router === router) return
    this.unsubscribe?.()
    this.router = router
    this.lastKey = router.state.location.key
    this.lastPathname = router.state.location.pathname
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

  private get topKey(): string | undefined {
    return this.sentinelKeys[this.sentinelKeys.length - 1]
  }

  /** Fed every location the router commits, by the subscription in {@link attachRouter}. */
  handleLocation(location: Location, navigationType: NavigationType): void {
    if (location.key === this.lastKey) return
    const leftKey = this.lastKey
    this.lastKey = location.key
    const leftPathname = this.lastPathname
    this.lastPathname = location.pathname
    const settledOp = this.inFlight
    this.inFlight = null

    if (location.pathname !== leftPathname) {
      this.sentinelKeys = []
    } else if (settledOp === "push") {
      this.sentinelKeys.push(location.key)
    } else if (settledOp === "pop") {
      this.sentinelKeys.pop()
    } else if (leftKey !== null && leftKey === this.topKey) {
      // The back gesture consumed our top entry: close its overlay in place.
      // Removed from the stack synchronously so the reconcile below sees the
      // depth already balanced and pushes nothing.
      if (navigationType === "POP") {
        this.sentinelKeys.pop()
        this.stack.pop()?.close()
      }
      // A replace rewrote our entry into one the app owns (a menu item that
      // closes its drawer and replace-navigates): the entry is no longer ours
      // to pop.
      else if (navigationType === "REPLACE") this.sentinelKeys.pop()
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
    const want = this.stack.length
    if (want > this.sentinelKeys.length) {
      this.inFlight = "push"
      void router.navigate(
        { pathname: location.pathname, search: location.search, hash: location.hash },
        { state: location.state, preventScrollReset: true }
      )
    } else if (want < this.sentinelKeys.length && location.key === this.topKey) {
      this.inFlight = "pop"
      void router.navigate(-1)
    }
  }

  resetForTests(): void {
    this.stack = []
    this.inFlight = null
    this.sentinelKeys = []
    this.lastKey = null
    this.lastPathname = null
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
 * the overlay's entry back out, so a later back press never resurfaces a
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
