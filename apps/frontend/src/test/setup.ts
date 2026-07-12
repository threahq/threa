import "fake-indexeddb/auto"
import "@testing-library/jest-dom/vitest"
import { beforeEach } from "vitest"
import { __resetCollapseCacheForTests } from "@/lib/markdown/collapse-cache"

// Node ≥25 ships an experimental global `localStorage` (enabled with an implicit
// `--localstorage-file`) that shadows jsdom's spec-compliant one but omits the
// standard methods (`clear`/`removeItem` throw), so every localStorage-backed
// test breaks under it. When the active global is that broken build, replace it
// with an in-memory Storage. Guarded on a missing `clear`, so on a Node/CI
// runtime whose `localStorage` already works this is a no-op.
if (typeof globalThis.localStorage === "undefined" || typeof globalThis.localStorage.clear !== "function") {
  const store = new Map<string, string>()
  const storage: Storage = {
    get length() {
      return store.size
    },
    clear: () => store.clear(),
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    key: (index) => [...store.keys()][index] ?? null,
    removeItem: (key) => void store.delete(key),
    setItem: (key, value) => void store.set(String(key), String(value)),
  }
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true, writable: true })
}

// The markdown-block + link-preview collapse cache is module-scoped, so its
// state would otherwise leak between tests. Reset it before each case so
// every test starts with an empty (unhydrated) cache.
beforeEach(() => {
  __resetCollapseCacheForTests()
})

// In-memory BroadcastChannel (jsdom lacks it). Cross-instance delivery within
// the process lets the AccountScope cross-tab switch test exercise two
// provider trees over one channel. Messages dispatch async (microtask) to
// match the real API's "not delivered to the sender, delivered to others".
if (typeof globalThis.BroadcastChannel === "undefined") {
  const registry = new Map<string, Set<TestBroadcastChannel>>()

  class TestBroadcastChannel {
    readonly name: string
    onmessage: ((ev: MessageEvent) => void) | null = null
    private closed = false

    constructor(name: string) {
      this.name = name
      let peers = registry.get(name)
      if (!peers) {
        peers = new Set()
        registry.set(name, peers)
      }
      peers.add(this)
    }

    postMessage(data: unknown): void {
      if (this.closed) return
      const peers = registry.get(this.name)
      if (!peers) return
      for (const peer of peers) {
        if (peer === this || peer.closed) continue
        queueMicrotask(() => {
          if (!peer.closed) peer.onmessage?.({ data } as MessageEvent)
        })
      }
    }

    close(): void {
      this.closed = true
      registry.get(this.name)?.delete(this)
    }

    addEventListener(): void {}
    removeEventListener(): void {}
    dispatchEvent(): boolean {
      return false
    }
  }

  globalThis.BroadcastChannel = TestBroadcastChannel as unknown as typeof BroadcastChannel
}

// Mock scrollIntoView (not available in jsdom)
Element.prototype.scrollIntoView = () => {}

// Pointer-capture APIs (not implemented in jsdom). Radix Select/Dropdown call
// these during pointer interactions, so userEvent clicks throw without them.
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.setPointerCapture ??= () => {}
Element.prototype.releasePointerCapture ??= () => {}

// Mock matchMedia (not available in jsdom, needed by useIsMobile)
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
})

// ResizeObserver for cmdk and other components
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// ProseMirror needs getClientRects for scroll calculations
if (typeof Range !== "undefined") {
  // @ts-expect-error - polyfill for jsdom
  Range.prototype.getClientRects = function () {
    return {
      length: 0,
      item: () => null,
      [Symbol.iterator]: function* () {},
    }
  }
  Range.prototype.getBoundingClientRect = function () {
    return {
      top: 0,
      left: 0,
      bottom: 0,
      right: 0,
      width: 0,
      height: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }
  }
}

// Elements need getClientRects too
if (!Element.prototype.getClientRects) {
  // @ts-expect-error - polyfill for jsdom
  Element.prototype.getClientRects = function () {
    return {
      length: 0,
      item: () => null,
      [Symbol.iterator]: function* () {},
    }
  }
}

// elementFromPoint is needed by ProseMirror for click handling
if (!document.elementFromPoint) {
  document.elementFromPoint = () => null
}
