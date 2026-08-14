import { MOBILE_BREAKPOINT } from "@/hooks/use-mobile"

/**
 * Persists the last-measured composer height and applies it as a global
 * fallback CSS variable on `:root` before the editor zone mounts.
 *
 * Why: the timeline's footer spacer reserves vertical space for the floating
 * composer pill via `var(--composer-height, 0px)`. That variable is set by
 * `useComposerHeightPublish` on the nearest `[data-editor-zone]` ancestor —
 * but the composer measures in a layout effect, which runs after the first
 * render commits. Until then the fallback (0px) would win, so Virtuoso's
 * mount-time measurement (which precedes the composer's layout effect) sizes
 * the footer at 0 and the spacer grows from 0 to ~80px before paint. Inside
 * Virtuoso's `stickToBottom` mode that growth forces the list to shift content
 * up by the same amount, which the user sees as the timeline "jumping" on
 * every hard refresh.
 *
 * Persisting the last-known height to `localStorage` and applying it to
 * `:root` before React mounts means the first render of the spacer already
 * reserves roughly the right space. The editor-zone override that runs in the
 * composer's layout effect later corrects any residual drift pre-paint (and
 * notifies the timeline to re-anchor in the same frame), so there is no
 * visible jump.
 *
 * The persisted value and boot fallback are keyed by viewport class. The
 * desktop composer carries an always-on bottom action bar and larger `sm:`
 * shell padding the collapsed mobile composer doesn't, so its empty height
 * (~140px) is far taller than mobile's (~80px). A single shared key let a
 * height measured on one viewport seed the other's boot fallback — a mobile
 * height applied on desktop reserves too little, so the taller desktop
 * composer overlaps the last message and the scroll engine (which offsets by
 * the same variable) can't bring it into view until live measurement catches
 * up, and never if that measurement stalls.
 */

const CSS_VAR = "--composer-height"

const STORAGE_KEY_DESKTOP = "threa:composer-height:desktop"
const STORAGE_KEY_MOBILE = "threa:composer-height:mobile"

// Boot fallback when nothing is persisted yet for this viewport (e.g. a
// brand-new install). Mobile matches the collapsed empty-state composer;
// desktop must clear the editor + always-on action bar + `sm:` shell padding so
// the timeline reserves enough space before the composer mounts and measures.
const DEFAULT_HEIGHT_MOBILE_PX = 80
const DEFAULT_HEIGHT_DESKTOP_PX = 144

// Floor for the desktop boot value. A persisted desktop value below this is too
// small to be a real desktop composer — a stale one-line disabled-banner
// measurement, or a value left over from before per-viewport keying — and would
// under-reserve, so it's raised to the floor. Kept below the empty desktop
// composer height so a genuine measurement is never floored *up* (which would
// over-reserve and reintroduce the reload jump this module exists to avoid).
const MIN_HEIGHT_DESKTOP_PX = 120

// Bounds that filter out clearly-bogus values from `localStorage` (corrupt
// data, future viewport changes that no longer reflect the current chrome).
const MIN_HEIGHT_PX = 40
const MAX_HEIGHT_PX = 400

function isDesktopViewport(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false
  return window.matchMedia(`(min-width: ${MOBILE_BREAKPOINT}px)`).matches
}

function storageKey(isDesktop: boolean): string {
  return isDesktop ? STORAGE_KEY_DESKTOP : STORAGE_KEY_MOBILE
}

function readPersisted(key: string): number | null {
  if (typeof localStorage === "undefined") return null
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed = Number.parseInt(raw, 10)
    if (!Number.isFinite(parsed)) return null
    if (parsed < MIN_HEIGHT_PX || parsed > MAX_HEIGHT_PX) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * Reads the persisted composer height for the current viewport (if any) and
 * applies it as the global `--composer-height` fallback on `:root`. Called once
 * at app boot from `main.tsx`. Safe to call before React mounts.
 */
export function applyPersistedComposerHeight(): void {
  if (typeof document === "undefined") return
  const isDesktop = isDesktopViewport()
  const persisted = readPersisted(storageKey(isDesktop))
  const applied = isDesktop
    ? Math.max(persisted ?? DEFAULT_HEIGHT_DESKTOP_PX, MIN_HEIGHT_DESKTOP_PX)
    : (persisted ?? DEFAULT_HEIGHT_MOBILE_PX)
  document.documentElement.style.setProperty(CSS_VAR, `${applied}px`)
}

/**
 * Live publishers of the global variable, in write order (a `Map` re-keyed on
 * every write, so the last entry is the most recently measured composer).
 */
const rootPublishers = new Map<HTMLElement, number>()

/**
 * Mirrors a live composer measurement onto `:root`.
 *
 * `useComposerHeightPublish` scopes the variable to the nearest
 * `[data-editor-zone]`, which is right for the timeline spacer but leaves the
 * app-level fixed surfaces (the call dock's idle chips, the incoming-call ring)
 * out of reach — they mount as siblings of the shell, so on a phone they read
 * the boot approximation applied above for the whole session. A previous
 * session's long draft persists ~350px and the chip then floats mid-screen.
 *
 * Most recent writer wins. Several editor zones can be mounted (main timeline +
 * thread panel), but only the one the user last touched is under the dock on a
 * phone, and it is the one that last measured. Dropping a publisher falls back
 * to the newest survivor rather than the boot value, so closing the panel
 * re-reveals the main composer's real height instead of a stale one.
 */
export function publishComposerHeightToRoot(el: HTMLElement, heightPx: number): void {
  if (typeof document === "undefined") return
  rootPublishers.delete(el)
  rootPublishers.set(el, heightPx)
  document.documentElement.style.setProperty(CSS_VAR, `${heightPx}px`)
}

export function unpublishComposerHeightFromRoot(el: HTMLElement): void {
  if (typeof document === "undefined") return
  if (!rootPublishers.delete(el)) return
  let survivor: number | null = null
  for (const px of rootPublishers.values()) survivor = px
  if (survivor === null) return
  document.documentElement.style.setProperty(CSS_VAR, `${survivor}px`)
}

// --- Mobile drag-resize preference -----------------------------------------

const STORAGE_KEY_DRAG_HEIGHT = "threa:composer-drag-height"

/** Mobile card floor: border + padding + one editor line + gap + action bar. */
export const MOBILE_COMPOSER_DRAG_MIN_PX = 104
// Sanity ceiling for persisted values only — the live drag clamps to 75% of
// the visual viewport, which no phone exceeds.
const MAX_DRAG_HEIGHT_PX = 1200

/**
 * The user-chosen mobile composer height from the drag handle (a max-height:
 * the composer stays content-driven below it). Persisted per device so the
 * preference survives reloads; null when the user has never dragged.
 */
export function loadMobileComposerDragHeight(): number | null {
  if (typeof localStorage === "undefined") return null
  try {
    const raw = localStorage.getItem(STORAGE_KEY_DRAG_HEIGHT)
    if (!raw) return null
    const parsed = Number.parseInt(raw, 10)
    if (!Number.isFinite(parsed)) return null
    if (parsed < MOBILE_COMPOSER_DRAG_MIN_PX || parsed > MAX_DRAG_HEIGHT_PX) return null
    return parsed
  } catch {
    return null
  }
}

export function persistMobileComposerDragHeight(heightPx: number): void {
  if (typeof localStorage === "undefined") return
  const rounded = Math.round(heightPx)
  if (rounded < MOBILE_COMPOSER_DRAG_MIN_PX || rounded > MAX_DRAG_HEIGHT_PX) return
  try {
    localStorage.setItem(STORAGE_KEY_DRAG_HEIGHT, String(rounded))
  } catch {
    // Storage quota / private-mode failures shouldn't crash the render path.
  }
}

/**
 * Persists a freshly-measured composer height for the next page load, keyed by
 * the current viewport so mobile and desktop never seed each other's fallback.
 * No-op when the value is outside the sanity window so corrupt measurements
 * (e.g. during a transient layout glitch) don't poison subsequent boots.
 */
export function persistComposerHeight(heightPx: number): void {
  if (typeof localStorage === "undefined") return
  const rounded = Math.round(heightPx)
  if (rounded < MIN_HEIGHT_PX || rounded > MAX_HEIGHT_PX) return
  try {
    localStorage.setItem(storageKey(isDesktopViewport()), String(rounded))
  } catch {
    // Storage quota / private-mode failures shouldn't crash the render path.
  }
}
