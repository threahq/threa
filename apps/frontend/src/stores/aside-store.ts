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

export type AsideSurface = "dock" | "fullscreen" | "minimized"

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

let state: OpenAsideState | null = null
const listeners = new Set<() => void>()
// Resume re-enters the surface the aside was last read in. Minimized is a
// parked state, not a reading surface, so it never becomes the remembered one.
const lastReadingSurfaceByAside = new Map<string, Exclude<AsideSurface, "minimized">>()

function emit(): void {
  for (const listener of listeners) listener()
}

function setState(next: OpenAsideState | null): void {
  state = next
  emit()
}

function remember(asideId: string, surface: AsideSurface): void {
  if (surface !== "minimized") lastReadingSurfaceByAside.set(asideId, surface)
}

export function getAsideState(): OpenAsideState | null {
  return state
}

/** The surface an aside was last read in, for resume; null for a never-opened aside. */
export function rememberedAsideSurface(asideId: string): Exclude<AsideSurface, "minimized"> | null {
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
  setState(null)
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
