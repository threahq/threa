import { useSyncExternalStore } from "react"

/**
 * User-scoped call layout preferences, persisted to localStorage and read
 * synchronously at module import so the first render reflects the saved choice.
 * Unlike {@link import("./call-store").CallState} these survive a call ending —
 * they're a preference, not live call state.
 *
 * INV-9 exception (module singleton): a synchronous source of truth readable from
 * any surface without context plumbing; `useSyncExternalStore` consumers detach on
 * unmount. All localStorage access is best-effort — private mode / quota / malformed
 * JSON fall safe to defaults rather than throwing.
 */

export type CallLayout = "speaker" | "grid"
export type CallDockPosition = "top" | "side"
export type CallFilmstripSide = "bottom" | "side"
/** Local self-view mirroring. `auto` = mirror a front/desktop camera, not a mobile back camera. */
export type CallSelfMirror = "auto" | "on" | "off"

export interface CallPrefs {
  layout: CallLayout
  dockPosition: CallDockPosition
  filmstripSide: CallFilmstripSide
  selfMirror: CallSelfMirror
}

const DEFAULT_PREFS: CallPrefs = {
  layout: "speaker",
  dockPosition: "side",
  filmstripSide: "bottom",
  selfMirror: "auto",
}
const STORAGE_KEY = "threa:callPrefs:v1"

const isLayout = (v: unknown): v is CallLayout => v === "speaker" || v === "grid"
const isDockPosition = (v: unknown): v is CallDockPosition => v === "top" || v === "side"
const isFilmstripSide = (v: unknown): v is CallFilmstripSide => v === "bottom" || v === "side"
const isSelfMirror = (v: unknown): v is CallSelfMirror => v === "auto" || v === "on" || v === "off"

/**
 * Resolve the effective self-view mirror. `auto` mirrors a front-facing view (any
 * desktop camera, a mobile front/default camera) and leaves a mobile back camera
 * un-mirrored — matching Messenger. An explicit `on`/`off` overrides. Local preview
 * only; peers always see the un-mirrored feed.
 */
export function resolveSelfMirror(
  pref: CallSelfMirror,
  { isMobile, facingMode }: { isMobile: boolean; facingMode: "user" | "environment" | null }
): boolean {
  if (pref === "on") return true
  if (pref === "off") return false
  if (!isMobile) return true
  return facingMode !== "environment"
}

function readPersisted(): CallPrefs {
  if (typeof localStorage === "undefined") return { ...DEFAULT_PREFS }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_PREFS }
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ...DEFAULT_PREFS }
    const p = parsed as Record<string, unknown>
    return {
      layout: isLayout(p.layout) ? p.layout : DEFAULT_PREFS.layout,
      dockPosition: isDockPosition(p.dockPosition) ? p.dockPosition : DEFAULT_PREFS.dockPosition,
      filmstripSide: isFilmstripSide(p.filmstripSide) ? p.filmstripSide : DEFAULT_PREFS.filmstripSide,
      selfMirror: isSelfMirror(p.selfMirror) ? p.selfMirror : DEFAULT_PREFS.selfMirror,
    }
  } catch {
    return { ...DEFAULT_PREFS }
  }
}

function persist(next: CallPrefs): void {
  if (typeof localStorage === "undefined") return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Quota / private mode: the in-memory value still holds for this tab.
  }
}

let prefs: CallPrefs = readPersisted()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

function update(patch: Partial<CallPrefs>): void {
  const next = { ...prefs, ...patch }
  if (
    next.layout === prefs.layout &&
    next.dockPosition === prefs.dockPosition &&
    next.filmstripSide === prefs.filmstripSide &&
    next.selfMirror === prefs.selfMirror
  ) {
    return
  }
  prefs = next
  persist(next)
  notify()
}

export function getCallPrefs(): CallPrefs {
  return prefs
}

export function setCallLayout(layout: CallLayout): void {
  update({ layout })
}

export function setCallDockPosition(dockPosition: CallDockPosition): void {
  update({ dockPosition })
}

export function setCallFilmstripSide(filmstripSide: CallFilmstripSide): void {
  update({ filmstripSide })
}

export function setCallSelfMirror(selfMirror: CallSelfMirror): void {
  update({ selfMirror })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useCallPrefs(): CallPrefs {
  return useSyncExternalStore(subscribe, getCallPrefs, getCallPrefs)
}

/** Test-only: re-read from (possibly test-seeded) localStorage and drop listeners. */
export function __resetCallPrefsForTests(): void {
  prefs = readPersisted()
  listeners.clear()
}
