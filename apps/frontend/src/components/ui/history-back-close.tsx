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
 * live entries we own toward the number of open overlays, one navigation at
 * a time (`inFlight` serializes ops, because a browser `history.go(-1)`
 * settles asynchronously and a concurrent push would interleave with it).
 * Overlay *handoffs* — a menu drawer closing while the dialog it launched
 * opens in the same tick — net out to the same depth, so they cost nothing.
 *
 * The one rule that matters on a phone: NEVER push after a back. Chrome marks
 * every same-document entry skippable when a `pushState` follows a
 * browser-initiated back without a user activation in between, and Android's
 * back then skips them all and leaves the app. So a back that leaves our top
 * entry closes its overlay and forgets the entry; a back that lands ON one of
 * our entries (an app entry above it was popped — the URL closes what it
 * opened) changes nothing, and the next press closes that overlay. An overlay
 * that closes while the app has navigated on top of its entry (the actions
 * drawer whose "Reply in thread" pushes `?panel=`) leaves that entry behind:
 * it is marked stale — no longer standing in for anything, so the next
 * overlay gets an entry of its own — and popped the moment a back lands on
 * it, a pop, never a push. Overlays close last-opened-first, so the stale one
 * is always our topmost live entry. A replace on our top entry keeps it ours
 * under its new key (the gallery swiping to the next item) unless the overlay
 * closed with it, in which case the entry is the app's now (a menu item that
 * closes its drawer and replace-navigates) and we let go of it.
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
  // The entries we pushed and still account for, bottom to top. A reloaded
  // session starts with none. `live` is false once the overlay it stood in
  // for has closed; `replaced` marks the top entry until the next navigation.
  private entries: { key: string; live: boolean; replaced: boolean }[] = []
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

  private get top() {
    return this.entries[this.entries.length - 1]
  }

  /** Fed every location the router commits, by the subscription in {@link attachRouter}. */
  handleLocation(location: Location, navigationType: NavigationType): void {
    if (location.key === this.lastKey) return
    const leftKey = this.lastKey
    this.lastKey = location.key
    const settledOp = this.inFlight
    this.inFlight = null
    const top = this.top
    if (top) top.replaced = false

    if (settledOp === "push") {
      this.entries.push({ key: location.key, live: true, replaced: false })
    } else if (settledOp === "pop") {
      this.entries.pop()
    } else if (top && leftKey === top.key) {
      // The back gesture consumed our top entry: close its overlay in place.
      // Removed from the stack synchronously so the reconcile below sees the
      // depth already balanced and pushes nothing.
      if (navigationType === "POP") {
        this.entries.pop()
        if (top.live) this.stack.pop()?.close()
      } else if (navigationType === "REPLACE") {
        top.key = location.key
        top.replaced = true
      }
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
    const live = this.entries.filter((entry) => entry.live).length
    const top = this.top
    const onTop = top !== undefined && location.key === top.key
    if (want > live) {
      this.inFlight = "push"
      void router.navigate(
        { pathname: location.pathname, search: location.search, hash: location.hash },
        { state: location.state, preventScrollReset: true }
      )
    } else if (want < live && onTop && top.replaced) {
      this.entries.pop()
      this.scheduleReconcile()
    } else if (onTop && (want < live || !top.live)) {
      this.inFlight = "pop"
      void router.navigate(-1)
    } else if (want < live) {
      // One entry per pass, then again: several overlays can close in one
      // commit (a page change unmounting a sheet and the drawer over it).
      for (let i = this.entries.length - 1; i >= 0; i--) {
        if (this.entries[i]!.live) {
          this.entries[i]!.live = false
          break
        }
      }
      this.scheduleReconcile()
    }
  }

  resetForTests(): void {
    this.stack = []
    this.inFlight = null
    this.entries = []
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
