import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MOBILE_BREAKPOINT } from "@/hooks/use-mobile"
import {
  applyPersistedComposerHeight,
  persistComposerHeight,
  clearMobileComposerDragHeight,
  loadMobileComposerDragHeight,
  persistMobileComposerDragHeight,
  MOBILE_COMPOSER_DRAG_MIN_PX,
} from "./composer-height-storage"

const DESKTOP_KEY = "threa:composer-height:desktop"
const MOBILE_KEY = "threa:composer-height:mobile"

// Match the exact query `isDesktopViewport` issues. A loose `includes("min-width")`
// match would let a regressed breakpoint value (or query shape) still flip
// desktop detection and pass — this fails instead (INV-23). Built from the
// shared constant so a deliberate breakpoint change doesn't false-fail.
const DESKTOP_MEDIA_QUERY = `(min-width: ${MOBILE_BREAKPOINT}px)`

function stubViewport(isDesktop: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === DESKTOP_MEDIA_QUERY ? isDesktop : false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }))
}

function rootComposerHeight(): string {
  return document.documentElement.style.getPropertyValue("--composer-height")
}

// Node 25 ships a file-backed `localStorage` global that shadows jsdom's and
// throws on mutation without `--localstorage-file`. Back the module's storage
// with a plain Map so the test exercises real read/write behaviour.
function stubStorage() {
  const store = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size
    },
  })
}

beforeEach(() => {
  stubStorage()
  document.documentElement.style.removeProperty("--composer-height")
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("applyPersistedComposerHeight", () => {
  it("falls back to the taller desktop default on desktop when nothing is persisted", () => {
    stubViewport(true)
    applyPersistedComposerHeight()
    expect(rootComposerHeight()).toBe("144px")
  })

  it("falls back to the collapsed mobile default on mobile when nothing is persisted", () => {
    stubViewport(false)
    applyPersistedComposerHeight()
    expect(rootComposerHeight()).toBe("80px")
  })

  it("does not let a mobile-measured height seed the desktop fallback", () => {
    // Persist while on a narrow viewport, then boot on desktop. The desktop key
    // is untouched, so the desktop default wins instead of the mobile height.
    stubViewport(false)
    persistComposerHeight(82)
    stubViewport(true)
    applyPersistedComposerHeight()
    expect(localStorage.getItem(MOBILE_KEY)).toBe("82")
    expect(localStorage.getItem(DESKTOP_KEY)).toBeNull()
    expect(rootComposerHeight()).toBe("144px")
  })

  it("raises a too-small persisted desktop value to the desktop floor", () => {
    stubViewport(true)
    localStorage.setItem(DESKTOP_KEY, "60")
    applyPersistedComposerHeight()
    expect(rootComposerHeight()).toBe("120px")
  })

  it("uses a genuine desktop measurement unchanged (not floored up)", () => {
    stubViewport(true)
    localStorage.setItem(DESKTOP_KEY, "168")
    applyPersistedComposerHeight()
    expect(rootComposerHeight()).toBe("168px")
  })

  it("ignores out-of-bounds persisted values and uses the default", () => {
    stubViewport(true)
    localStorage.setItem(DESKTOP_KEY, "9999")
    applyPersistedComposerHeight()
    expect(rootComposerHeight()).toBe("144px")
  })
})

describe("persistComposerHeight", () => {
  it("writes the measured height to the active viewport's key", () => {
    stubViewport(true)
    persistComposerHeight(150)
    expect(localStorage.getItem(DESKTOP_KEY)).toBe("150")
    expect(localStorage.getItem(MOBILE_KEY)).toBeNull()
  })

  it("round-trips a desktop measurement back onto :root", () => {
    stubViewport(true)
    persistComposerHeight(152)
    document.documentElement.style.removeProperty("--composer-height")
    applyPersistedComposerHeight()
    expect(rootComposerHeight()).toBe("152px")
  })

  it("drops measurements outside the sanity window", () => {
    stubViewport(true)
    persistComposerHeight(12)
    persistComposerHeight(999)
    expect(localStorage.getItem(DESKTOP_KEY)).toBeNull()
  })
})

describe("mobile composer drag height", () => {
  const DRAG_KEY = "threa:composer-drag-height"

  beforeEach(() => {
    localStorage.clear()
  })

  it("round-trips the dragged height", () => {
    persistMobileComposerDragHeight(287.4)
    expect(localStorage.getItem(DRAG_KEY)).toBe("287")
    expect(loadMobileComposerDragHeight()).toBe(287)
  })

  it("accepts the compact one-line floor", () => {
    persistMobileComposerDragHeight(MOBILE_COMPOSER_DRAG_MIN_PX)
    expect(loadMobileComposerDragHeight()).toBe(104)
  })

  it("clears the dragged height when minimizing to the natural default", () => {
    persistMobileComposerDragHeight(287)
    clearMobileComposerDragHeight()
    expect(loadMobileComposerDragHeight()).toBeNull()
  })

  it("persists fullscreen heights allowed by a tall coarse-pointer viewport", () => {
    vi.stubGlobal("visualViewport", { width: 1024, height: 1366 })
    persistMobileComposerDragHeight(1300)
    expect(loadMobileComposerDragHeight()).toBe(1300)
  })

  it("returns null when never dragged", () => {
    expect(loadMobileComposerDragHeight()).toBeNull()
  })

  it("drops values outside the sanity window on both write and read", () => {
    persistMobileComposerDragHeight(MOBILE_COMPOSER_DRAG_MIN_PX - 1)
    expect(localStorage.getItem(DRAG_KEY)).toBeNull()
    persistMobileComposerDragHeight(5000)
    expect(localStorage.getItem(DRAG_KEY)).toBeNull()
    localStorage.setItem(DRAG_KEY, "12")
    expect(loadMobileComposerDragHeight()).toBeNull()
    localStorage.setItem(DRAG_KEY, "junk")
    expect(loadMobileComposerDragHeight()).toBeNull()
  })
})
