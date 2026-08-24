import { useSyncExternalStore } from "react"

/**
 * Module store for the one aside surface open on the current page. An aside is
 * stream-bound: the state is keyed by the host page (`hostKey`, the route
 * pathname) and the page's surface mount drops it on unmount, so navigating
 * away leaves no aside chrome anywhere else by construction and coming back
 * restores nothing — the anchor row is the way back in.
 *
 * INV-59 exemption, the call dock's shape (`call-dock.tsx`): which aside is
 * open and in what surface is transient view state that must NOT survive a
 * refresh or a shared link (a private aside re-opening from a URL would leak
 * its existence into the address bar), so it lives here, never in `?panel=`.
 * Registered in `flushModuleStoreCaches` (account-scope.tsx) like every
 * sibling store.
 */

export type AsideSurface = "dock" | "fullscreen"

export interface OpenAsideState {
  /** The page hosting the surface — `useLocation().pathname`. */
  hostKey: string
  hostStreamId: string
  asideId: string
  surface: AsideSurface
  /**
   * The draft scope a hand-off files into: the host stream's own composer, or
   * the conversation's reply composer when the aside was opened on one. Fixed
   * at open, so what you send lands where you were writing.
   */
  originScope: string
}

/** Dock width bounds. The floor keeps the chat and its composer usable; the
 *  ceiling is enforced against the live container by the slot, which knows how
 *  much room the host timeline still needs. */
export const ASIDE_DOCK_MIN_WIDTH = 320
export const ASIDE_DOCK_DEFAULT_WIDTH = 400

let state: OpenAsideState | null = null
const listeners = new Set<() => void>()
// Dock width the user dragged, per aside. Session-scoped like the surface
// itself: a width is a reading preference for this sitting, not something a
// refresh or a shared link should carry (INV-59 exemption, same rationale as
// the open surface above).
const dockWidthByAside = new Map<string, number>()
// Resume re-enters the surface the aside was last read in.
const lastReadingSurfaceByAside = new Map<string, AsideSurface>()

function emit(): void {
  for (const listener of listeners) listener()
}

function setState(next: OpenAsideState | null): void {
  state = next
  emit()
}

function remember(asideId: string, surface: AsideSurface): void {
  lastReadingSurfaceByAside.set(asideId, surface)
}

export function getAsideState(): OpenAsideState | null {
  return state
}

/** The surface an aside was last read in, for resume; null for a never-opened aside. */
export function rememberedAsideSurface(asideId: string): AsideSurface | null {
  return lastReadingSurfaceByAside.get(asideId) ?? null
}

export function openAside(next: OpenAsideState): void {
  remember(next.asideId, next.surface)
  setState(next)
}

export function setAsideSurface(surface: AsideSurface): void {
  if (!state || state.surface === surface) return
  remember(state.asideId, surface)
  setState({ ...state, surface })
}

export function closeAside(): void {
  if (!state) return
  setState(null)
}

/** Drop the surface when its host page goes away; a no-op for any other host. */
export function dropAsideForHost(hostKey: string): void {
  if (state?.hostKey !== hostKey) return
  setState(null)
}

export function resetAsideStoreCache(): void {
  lastReadingSurfaceByAside.clear()
  dockWidthByAside.clear()
  setState(null)
}

/** The width this aside's dock was last dragged to, or the default. */
export function asideDockWidth(asideId: string): number {
  return dockWidthByAside.get(asideId) ?? ASIDE_DOCK_DEFAULT_WIDTH
}

export function setAsideDockWidth(asideId: string, width: number): void {
  dockWidthByAside.set(asideId, Math.max(ASIDE_DOCK_MIN_WIDTH, Math.round(width)))
  emit()
}

/** The dock width for `asideId`, re-rendering the slot as it is dragged. */
export function useAsideDockWidth(asideId: string | null): number {
  return useSyncExternalStore(
    subscribe,
    () => (asideId ? asideDockWidth(asideId) : ASIDE_DOCK_DEFAULT_WIDTH),
    () => (asideId ? asideDockWidth(asideId) : ASIDE_DOCK_DEFAULT_WIDTH)
  )
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useAsideState(): OpenAsideState | null {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state
  )
}

/** The aside open on `hostKey`'s page, or null. */
export function useAsideForHost(hostKey: string): OpenAsideState | null {
  const current = useAsideState()
  return current?.hostKey === hostKey ? current : null
}
