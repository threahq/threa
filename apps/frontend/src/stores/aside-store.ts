import { useSyncExternalStore } from "react"
import type { AgentBlockData } from "@/components/timeline/agent-block-context"

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

/** How tall the drafts half of the aside is, between its own floor and whatever
 *  the surface can spare — the conversation's floor is enforced by the pane. */
export const ASIDE_DRAFT_MIN_HEIGHT = 180
export const ASIDE_DRAFT_DEFAULT_HEIGHT = 320

let state: OpenAsideState | null = null
const listeners = new Set<() => void>()
// Dock width the user dragged, per aside. Session-scoped like the surface
// itself: a width is a reading preference for this sitting, not something a
// refresh or a shared link should carry (INV-59 exemption, same rationale as
// the open surface above).
const dockWidthByAside = new Map<string, number>()
// Resume re-enters the surface the aside was last read in.
const lastReadingSurfaceByAside = new Map<string, AsideSurface>()
// The draft open for writing, per aside. Here rather than in the surface
// component because dock and fullscreen are different components: holding it
// locally would close the draft mid-sentence every time the surface changed.
const openDraftByAside = new Map<string, string>()
// Agent replies queued by "Insert into draft" and not yet appended — the
// editor takes them once its draft has hydrated. Here for the same reason as
// the open draft above: a surface switch during that hydration would otherwise
// unmount the only copy and lose the block.
const pendingAgentBlocksByAside = new Map<string, AgentBlockData[]>()
// How the drafts half is split against the conversation, and whether the tray
// of pills is unfolded. Session-scoped per aside, like the dock width.
const draftHeightByAside = new Map<string, number>()
const trayExpandedByAside = new Map<string, boolean>()

function emit(): void {
  for (const listener of listeners) listener()
}

function setState(next: OpenAsideState | null): void {
  state = next
  emit()
}

/**
 * Only a surface the user CHOSE is remembered. An open can be coerced — a
 * docked call pushes an aside that wanted the dock into fullscreen — and
 * recording that would make one call change where every later aside opens.
 */
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
  openDraftByAside.clear()
  pendingAgentBlocksByAside.clear()
  draftHeightByAside.clear()
  trayExpandedByAside.clear()
  setState(null)
}

/** The draft scope open for writing in this aside, or null. */
export function asideOpenDraft(asideId: string): string | null {
  return openDraftByAside.get(asideId) ?? null
}

export function setAsideOpenDraft(asideId: string, scope: string | null): void {
  if (scope) openDraftByAside.set(asideId, scope)
  else openDraftByAside.delete(asideId)
  emit()
}

/** The draft open in `asideId`, across a surface switch. */
export function useAsideOpenDraft(asideId: string): string | null {
  return useSyncExternalStore(
    subscribe,
    () => asideOpenDraft(asideId),
    () => asideOpenDraft(asideId)
  )
}

const NO_PENDING_BLOCKS: AgentBlockData[] = []

/** Agent replies waiting to be appended to `asideId`'s open draft. */
export function asidePendingAgentBlocks(asideId: string): AgentBlockData[] {
  return pendingAgentBlocksByAside.get(asideId) ?? NO_PENDING_BLOCKS
}

export function queueAsideAgentBlock(asideId: string, block: AgentBlockData): void {
  pendingAgentBlocksByAside.set(asideId, [...asidePendingAgentBlocks(asideId), block])
  emit()
}

export function clearAsideAgentBlocks(asideId: string): void {
  if (!pendingAgentBlocksByAside.delete(asideId)) return
  emit()
}

/** The queue for `asideId`, across a surface switch. */
export function useAsidePendingAgentBlocks(asideId: string): AgentBlockData[] {
  return useSyncExternalStore(
    subscribe,
    () => asidePendingAgentBlocks(asideId),
    () => asidePendingAgentBlocks(asideId)
  )
}

/** How tall this aside's drafts half was last dragged to, or the default. */
export function asideDraftHeight(asideId: string): number {
  return draftHeightByAside.get(asideId) ?? ASIDE_DRAFT_DEFAULT_HEIGHT
}

export function setAsideDraftHeight(asideId: string, height: number): void {
  draftHeightByAside.set(asideId, Math.max(ASIDE_DRAFT_MIN_HEIGHT, Math.round(height)))
  emit()
}

/** The drafts-half height for `asideId`, re-rendering the pane as it is dragged. */
export function useAsideDraftHeight(asideId: string): number {
  return useSyncExternalStore(
    subscribe,
    () => asideDraftHeight(asideId),
    () => asideDraftHeight(asideId)
  )
}

/** Whether this aside's tray of draft pills is unfolded. Folded by default: the
 *  count is the resting state, the pills are what you ask for. */
export function asideTrayExpanded(asideId: string): boolean {
  return trayExpandedByAside.get(asideId) ?? false
}

export function setAsideTrayExpanded(asideId: string, expanded: boolean): void {
  trayExpandedByAside.set(asideId, expanded)
  emit()
}

export function useAsideTrayExpanded(asideId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => asideTrayExpanded(asideId),
    () => asideTrayExpanded(asideId)
  )
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
