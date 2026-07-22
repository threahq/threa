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
export type CallFilmstripSide = "bottom" | "side"
/** Local self-view mirroring. `auto` = mirror a front/desktop camera, not a mobile back camera. */
export type CallSelfMirror = "auto" | "on" | "off"
/** A concrete desktop call surface. */
export type DesktopSurface = "sidebar" | "floating"
/** The desktop-surface preference: `keep_last` reopens wherever the last call was. */
export type DesktopCallSurface = "keep_last" | DesktopSurface

export interface CallPrefs {
  layout: CallLayout
  filmstripSide: CallFilmstripSide
  selfMirror: CallSelfMirror
  /** Last resting open width (px) of the desktop side dock; `null` = never resized. */
  sideDockWidth: number | null
  /** Which desktop surface a call opens on. */
  desktopCallSurface: DesktopCallSurface
  /** The surface the last desktop call resolved to — the target of `keep_last`. */
  lastDesktopSurface: DesktopSurface
}

const DEFAULT_PREFS: CallPrefs = {
  layout: "speaker",
  filmstripSide: "bottom",
  selfMirror: "auto",
  sideDockWidth: null,
  desktopCallSurface: "keep_last",
  lastDesktopSurface: "floating",
}
const STORAGE_KEY = "threa:callPrefs:v1"

const isLayout = (v: unknown): v is CallLayout => v === "speaker" || v === "grid"
const isFilmstripSide = (v: unknown): v is CallFilmstripSide => v === "bottom" || v === "side"
const isSelfMirror = (v: unknown): v is CallSelfMirror => v === "auto" || v === "on" || v === "off"
const isDesktopSurface = (v: unknown): v is DesktopSurface => v === "sidebar" || v === "floating"
const isDesktopCallSurface = (v: unknown): v is DesktopCallSurface => v === "keep_last" || isDesktopSurface(v)
const parseSideDockWidth = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null

/**
 * Resolve the effective desktop surface. An in-call session override wins; else
 * `keep_last` follows the last-used surface and an explicit pin returns as-is.
 */
export function resolveDesktopSurface(
  pref: DesktopCallSurface,
  last: DesktopSurface,
  override: DesktopSurface | null
): DesktopSurface {
  if (override) return override
  if (pref === "keep_last") return last
  return pref
}

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
      filmstripSide: isFilmstripSide(p.filmstripSide) ? p.filmstripSide : DEFAULT_PREFS.filmstripSide,
      selfMirror: isSelfMirror(p.selfMirror) ? p.selfMirror : DEFAULT_PREFS.selfMirror,
      sideDockWidth: parseSideDockWidth(p.sideDockWidth),
      desktopCallSurface: isDesktopCallSurface(p.desktopCallSurface)
        ? p.desktopCallSurface
        : DEFAULT_PREFS.desktopCallSurface,
      lastDesktopSurface: isDesktopSurface(p.lastDesktopSurface)
        ? p.lastDesktopSurface
        : DEFAULT_PREFS.lastDesktopSurface,
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
    next.filmstripSide === prefs.filmstripSide &&
    next.selfMirror === prefs.selfMirror &&
    next.sideDockWidth === prefs.sideDockWidth &&
    next.desktopCallSurface === prefs.desktopCallSurface &&
    next.lastDesktopSurface === prefs.lastDesktopSurface
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

export function setCallFilmstripSide(filmstripSide: CallFilmstripSide): void {
  update({ filmstripSide })
}

export function setCallSelfMirror(selfMirror: CallSelfMirror): void {
  update({ selfMirror })
}

export function setCallSideDockWidth(px: number): void {
  update({ sideDockWidth: px })
}

export function setDesktopCallSurface(desktopCallSurface: DesktopCallSurface): void {
  update({ desktopCallSurface })
}

export function setLastDesktopSurface(lastDesktopSurface: DesktopSurface): void {
  update({ lastDesktopSurface })
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
