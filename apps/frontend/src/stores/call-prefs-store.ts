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

export interface CallPrefs {
  layout: CallLayout
  dockPosition: CallDockPosition
  filmstripSide: CallFilmstripSide
}

const DEFAULT_PREFS: CallPrefs = { layout: "speaker", dockPosition: "side", filmstripSide: "bottom" }
const STORAGE_KEY = "threa:callPrefs:v1"

const isLayout = (v: unknown): v is CallLayout => v === "speaker" || v === "grid"
const isDockPosition = (v: unknown): v is CallDockPosition => v === "top" || v === "side"
const isFilmstripSide = (v: unknown): v is CallFilmstripSide => v === "bottom" || v === "side"

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
    next.filmstripSide === prefs.filmstripSide
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
