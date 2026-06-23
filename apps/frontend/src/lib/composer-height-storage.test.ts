import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { applyPersistedComposerHeight, persistComposerHeight } from "./composer-height-storage"

const DESKTOP_KEY = "threa:composer-height:desktop"
const MOBILE_KEY = "threa:composer-height:mobile"

// `isDesktopViewport` checks `matchMedia("(min-width: 640px)")`; everything else
// the module reads (pointer, mobile) is irrelevant here.
function stubViewport(isDesktop: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("min-width") ? isDesktop : false,
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
