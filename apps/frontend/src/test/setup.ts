import "fake-indexeddb/auto"
import "@testing-library/jest-dom/vitest"
import { IDBFactory } from "fake-indexeddb"
import Dexie from "dexie"
import { cleanup } from "@testing-library/react"
import { onlineManager } from "@tanstack/react-query"
import { afterEach, beforeEach, vi } from "vitest"
import { setAssertedAccount } from "@/api/account-assertion"
import { setActiveDb, ThreaDatabase } from "@/db/database"
import { setStorageAccount } from "@/lib/account-storage"
import { __resetCollapseCacheForTests } from "@/lib/markdown/collapse-cache"

/**
 * Account-owned browser storage is namespaced, so a suite that names no account
 * exercises the unowned no-op path instead of the product path. Every test runs
 * as an account; tests about the boundary set the owner they mean.
 */
export const TEST_STORAGE_ACCOUNT = "user_test_owner"

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
  setStorageAccount(TEST_STORAGE_ACCOUNT)
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

// Files share a worker's module cache and globals (`isolate: false`), and this
// file runs again before every test file, so it puts back the state a fresh
// worker would have: no spies, stubs, fake timers, mounted trees, redefined
// DOM properties, storage, offline flag, module store caches or IndexedDB rows.
// Testing Library registers its auto-cleanup only on first import, once per
// worker, hence the explicit afterEach.
vi.restoreAllMocks()
vi.unstubAllGlobals()
vi.unstubAllEnvs()
vi.useRealTimers()
cleanup()
restoreGlobalProperties()
for (const name of document.documentElement.getAttributeNames()) document.documentElement.removeAttribute(name)
document.body.removeAttribute("style")
document.title = ""
localStorage.clear()
sessionStorage.clear()
onlineManager.setOnline(true)
setAssertedAccount(null)
const { flushModuleStoreCaches } = await import("@/auth/account-scope")
flushModuleStoreCaches()
globalThis.indexedDB = new IDBFactory()
Dexie.dependencies.indexedDB = globalThis.indexedDB
setActiveDb(new ThreaDatabase("threa"))
afterEach(() => cleanup())

/**
 * Tests redefine browser properties (`defineProperty(window, "innerHeight")`,
 * `HTMLElement.prototype.getBoundingClientRect = …`, user-event's clipboard on
 * `navigator`, a timer spy taken under a faked clock that restores the fake)
 * and not all of them put the original back. The first run in a worker records
 * each target's own properties; later runs restore that record.
 */
function restoreGlobalProperties(): void {
  const windowKeys = [
    "AudioContext",
    "AudioWorkletNode",
    "Date",
    "Notification",
    "PublicKeyCredential",
    "cancelAnimationFrame",
    "cancelIdleCallback",
    "clearImmediate",
    "clearInterval",
    "clearTimeout",
    "fetch",
    "innerHeight",
    "innerWidth",
    "location",
    "orientation",
    "performance",
    "queueMicrotask",
    "requestAnimationFrame",
    "requestIdleCallback",
    "sessionStorage",
    "setImmediate",
    "setInterval",
    "setTimeout",
    "visualViewport",
  ]
  const targets: Array<[object, () => PropertyKey[]]> = [
    [window, () => windowKeys],
    [navigator, () => Reflect.ownKeys(navigator)],
    [document, () => Reflect.ownKeys(document)],
    [screen, () => Reflect.ownKeys(screen)],
    [Element.prototype, () => Reflect.ownKeys(Element.prototype)],
    [HTMLElement.prototype, () => Reflect.ownKeys(HTMLElement.prototype)],
  ]
  const store = globalThis as { __testPropertyBaseline?: Map<PropertyKey, PropertyDescriptor | undefined>[] }
  if (!store.__testPropertyBaseline) {
    store.__testPropertyBaseline = targets.map(
      ([target, keys]) => new Map(keys().map((key) => [key, Object.getOwnPropertyDescriptor(target, key)]))
    )
    return
  }
  targets.forEach(([target, keys], index) => {
    const baseline = store.__testPropertyBaseline![index]!
    for (const key of keys()) {
      if (!baseline.get(key)) Reflect.deleteProperty(target, key)
    }
    for (const [key, original] of baseline) {
      if (original && !sameDescriptor(Object.getOwnPropertyDescriptor(target, key), original)) {
        Object.defineProperty(target, key, original)
      }
    }
  })
}

function sameDescriptor(a: PropertyDescriptor | undefined, b: PropertyDescriptor): boolean {
  return a !== undefined && a.value === b.value && a.get === b.get && a.set === b.set
}
