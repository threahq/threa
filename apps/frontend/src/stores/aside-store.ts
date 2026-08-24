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
 * open is transient view state that must NOT survive a refresh or a shared
 * link (a private aside re-opening from a URL would leak its existence into
 * the address bar), so it lives here, never in `?panel=`.
 * Registered in `flushModuleStoreCaches` (account-scope.tsx) like every
 * sibling store.
 */

/**
 * Where a phone's sheet is resting. Desktop has one surface (the stage), so
 * this is a sheet detent and nothing else — it never decides what is rendered,
 * only how much of it you can see.
 */
export type AsideSheetDetent = "peek" | "full"

export interface OpenAsideState {
  /** The page hosting the surface — `useLocation().pathname`. */
  hostKey: string
  hostStreamId: string
  asideId: string
  /**
   * The draft scope a hand-off files into: the host stream's own composer, or
   * the conversation's reply composer when the aside was opened on one. Fixed
   * at open, so what you send lands where you were writing.
   */
  originScope: string
}

/** How wide the aside's own column is on the stage. The floor keeps its chat
 *  and composer usable; the ceiling is enforced against the live stage by the
 *  component, which knows how much room the host pane still needs. */
export const ASIDE_STAGE_MIN_WIDTH = 360
export const ASIDE_STAGE_DEFAULT_WIDTH = 620

/** How tall the drafts half of the aside is, between its own floor and whatever
 *  the surface can spare — the conversation's floor is enforced by the pane. */
export const ASIDE_DRAFT_MIN_HEIGHT = 180
export const ASIDE_DRAFT_DEFAULT_HEIGHT = 320

let state: OpenAsideState | null = null
const listeners = new Set<() => void>()
// The stage's vertical divide, per aside. Session-scoped like the aside
// itself: a width is a reading preference for this sitting, not something a
// refresh or a shared link should carry (INV-59 exemption, same rationale as
// the open aside above).
const stageWidthByAside = new Map<string, number>()
// The phone sheet's detent. One aside is open at a time, so one value.
let sheetDetent: AsideSheetDetent = "peek"
// The draft open for writing, per aside. Here rather than in the surface
// component because the stage and the phone sheet are different components:
// holding it locally would close the draft mid-sentence on the crossover.
const openDraftByAside = new Map<string, string>()
// Agent replies queued by "Insert into draft" and not yet appended — the
// editor takes them once its draft has hydrated. Here for the same reason as
// the open draft above: unmounting the only copy during that hydration would
// lose the block.
const pendingAgentBlocksByAside = new Map<string, AgentBlockData[]>()
// How the drafts half is split against the conversation, and whether the tray
// of pills is unfolded. Session-scoped per aside, like the stage width.
const draftHeightByAside = new Map<string, number>()
const trayExpandedByAside = new Map<string, boolean>()

function emit(): void {
  for (const listener of listeners) listener()
}

function setState(next: OpenAsideState | null): void {
  state = next
  emit()
}

export function getAsideState(): OpenAsideState | null {
  return state
}

export function openAside(next: OpenAsideState): void {
  // A sheet always opens at the peek: the host you asked about stays on screen
  // above it, and pulling up is one gesture away.
  sheetDetent = "peek"
  setState(next)
}

export function getAsideSheetDetent(): AsideSheetDetent {
  return sheetDetent
}

export function setAsideSheetDetent(detent: AsideSheetDetent): void {
  if (sheetDetent === detent) return
  sheetDetent = detent
  emit()
}

export function useAsideSheetDetent(): AsideSheetDetent {
  return useSyncExternalStore(
    subscribe,
    () => sheetDetent,
    () => sheetDetent
  )
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
  stageWidthByAside.clear()
  sheetDetent = "peek"
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

/** The draft open in `asideId`, whichever surface is showing it. */
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

/** The queue for `asideId`, whichever surface is showing it. */
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

/** The width this aside's column was last dragged to, or the default. */
export function asideStageWidth(asideId: string): number {
  return stageWidthByAside.get(asideId) ?? ASIDE_STAGE_DEFAULT_WIDTH
}

export function setAsideStageWidth(asideId: string, width: number): void {
  stageWidthByAside.set(asideId, Math.max(ASIDE_STAGE_MIN_WIDTH, Math.round(width)))
  emit()
}

/** The stage width for `asideId`, re-rendering the stage as it is dragged. */
export function useAsideStageWidth(asideId: string): number {
  return useSyncExternalStore(
    subscribe,
    () => asideStageWidth(asideId),
    () => asideStageWidth(asideId)
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
