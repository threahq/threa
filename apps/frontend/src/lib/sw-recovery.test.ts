import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from "vitest"
import path from "node:path"
import fs from "node:fs"
import { chunkUrlFromError, isChunkLoadError, runSwRecovery } from "./sw-recovery"

describe("isChunkLoadError", () => {
  it("detects Chromium/Firefox dynamic-import failures", () => {
    const err = new TypeError(
      "Failed to fetch dynamically imported module: https://app.threa.io/assets/workspace-layout-CZWcI4f9.js"
    )
    expect(isChunkLoadError(err)).toBe(true)
  })

  it("detects Safari dynamic-import failures", () => {
    const err = new TypeError("error loading dynamically imported module")
    expect(isChunkLoadError(err)).toBe(true)
  })

  it("detects older Edge module-script failures", () => {
    const err = new Error("Importing a module script failed")
    expect(isChunkLoadError(err)).toBe(true)
  })

  it("accepts raw string errors (thrown non-Error values)", () => {
    expect(isChunkLoadError("Failed to fetch dynamically imported module")).toBe(true)
  })

  it("does not match unrelated errors", () => {
    expect(isChunkLoadError(new Error("Network request failed"))).toBe(false)
    expect(isChunkLoadError(new TypeError("Cannot read properties of undefined"))).toBe(false)
    expect(isChunkLoadError(null)).toBe(false)
    expect(isChunkLoadError(undefined)).toBe(false)
    expect(isChunkLoadError({ message: "Failed to fetch dynamically imported module" })).toBe(false)
  })
})

describe("chunkUrlFromError", () => {
  it("extracts the asset URL from a Chromium/Firefox import failure", () => {
    const err = new TypeError(
      "Failed to fetch dynamically imported module: https://app.threa.io/assets/workspace-layout-D6MDsthX.js"
    )
    expect(chunkUrlFromError(err)).toBe("https://app.threa.io/assets/workspace-layout-D6MDsthX.js")
  })

  it("extracts a .css asset URL", () => {
    expect(chunkUrlFromError("error loading module https://app.threa.io/assets/index-AbC123.css")).toBe(
      "https://app.threa.io/assets/index-AbC123.css"
    )
  })

  it("returns null when the message carries no URL", () => {
    expect(chunkUrlFromError(new TypeError("error loading dynamically imported module"))).toBeNull()
    expect(chunkUrlFromError(null)).toBeNull()
  })
})

describe("runSwRecovery", () => {
  const originalLocation = window.location

  beforeEach(() => {
    sessionStorage.clear()
    // jsdom's location.reload() throws "Not implemented" — replace it with a spy
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, reload: vi.fn() },
    })
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("")))
    )
  })

  afterEach(() => {
    Object.defineProperty(window, "location", { configurable: true, value: originalLocation })
    sessionStorage.clear()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("returns false without reloading once the per-session cap is reached", async () => {
    sessionStorage.setItem("sw-recovery-attempts", "2")
    const result = await runSwRecovery()
    expect(result).toBe(false)
    expect(window.location.reload).not.toHaveBeenCalled()
  })

  it("increments the attempt counter on each auto-recovery call", async () => {
    await runSwRecovery()
    expect(sessionStorage.getItem("sw-recovery-attempts")).toBe("1")
    await runSwRecovery()
    expect(sessionStorage.getItem("sw-recovery-attempts")).toBe("2")
  })

  it("stamps the last-attempt time so the watchdog's reset can be cooldown-gated", async () => {
    const now = 1_700_000_000_000
    vi.spyOn(Date, "now").mockReturnValue(now)
    await runSwRecovery()
    // The index.html CSS watchdog reads this stamp and refuses to clear the
    // shared counter while it's recent — that's what stops a broken-chunk
    // reload loop from zeroing the counter and never reaching the cap.
    expect(sessionStorage.getItem("sw-recovery-last")).toBe(String(now))
  })

  it("automatic recovery reloads without touching service workers, caches, or fetch", async () => {
    const getRegistrations = vi.fn(() => Promise.resolve([]))
    const cachesDelete = vi.fn(() => Promise.resolve(true))
    const cachesKeys = vi.fn(() => Promise.resolve(["workbox-precache-v2"]))
    vi.stubGlobal("navigator", { serviceWorker: { getRegistrations } })
    vi.stubGlobal("caches", { keys: cachesKeys, delete: cachesDelete })

    const result = await runSwRecovery()

    expect(result).toBe(true)
    expect(window.location.reload).toHaveBeenCalledOnce()
    expect(getRegistrations).not.toHaveBeenCalled()
    expect(cachesKeys).not.toHaveBeenCalled()
    expect(cachesDelete).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it("automatic recovery ignores bustUrls and still only performs a plain reload", async () => {
    const result = await runSwRecovery({ bustUrls: ["https://app.threa.io/assets/x-AbC123.js"] })
    expect(result).toBe(true)
    expect(window.location.reload).toHaveBeenCalledOnce()
    expect(fetch).not.toHaveBeenCalled()
  })

  it("returns false without reloading when sessionStorage is denied", async () => {
    vi.stubGlobal("sessionStorage", {
      getItem: vi.fn(() => {
        throw new DOMException("Denied", "SecurityError")
      }),
      setItem: vi.fn(() => {
        throw new DOMException("Denied", "SecurityError")
      }),
      removeItem: vi.fn(),
      clear: vi.fn(),
      get length() {
        return 0
      },
      key: vi.fn(() => null),
    } as unknown as Storage)

    const result = await runSwRecovery()

    expect(result).toBe(false)
    expect(window.location.reload).not.toHaveBeenCalled()
  })

  it("force: true does not stamp the last-attempt time", async () => {
    const result = await runSwRecovery({ force: true })
    expect(result).toBe(true)
    expect(sessionStorage.getItem("sw-recovery-last")).toBeNull()
  })

  it("force: true bypasses the cap and does not touch the counter", async () => {
    sessionStorage.setItem("sw-recovery-attempts", "2")
    const result = await runSwRecovery({ force: true })
    expect(result).toBe(true)
    expect(sessionStorage.getItem("sw-recovery-attempts")).toBe("2")
    expect(window.location.reload).toHaveBeenCalledOnce()
  })

  it("force-refetches the app shell past the browser HTTP cache", async () => {
    await runSwRecovery({ force: true })
    expect(fetch).toHaveBeenCalledWith("/index.html", { cache: "reload", signal: expect.any(AbortSignal) })
  })

  it("force-refetches the failing chunk URL so an immutable-cached bad response is overwritten", async () => {
    const bad = "https://app.threa.io/assets/workspace-layout-D6MDsthX.js"
    await runSwRecovery({ force: true, bustUrls: [bad] })
    expect(fetch).toHaveBeenCalledWith(bad, { cache: "reload", signal: expect.any(AbortSignal) })
    expect(fetch).toHaveBeenCalledWith("/index.html", { cache: "reload", signal: expect.any(AbortSignal) })
  })

  it("clears CacheStorage before refetching a poisoned chunk", async () => {
    const calls: string[] = []
    vi.stubGlobal("caches", {
      keys: vi.fn(async () => {
        calls.push("keys")
        return ["workbox-precache-v2"]
      }),
      delete: vi.fn(async () => {
        calls.push("delete")
        return true
      }),
    })
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls.push("fetch")
        return new Response("")
      })
    )

    await runSwRecovery({ force: true, bustUrls: ["https://app.threa.io/assets/workspace-layout-D6MDsthX.js"] })

    expect(calls.slice(0, 3)).toEqual(["keys", "delete", "fetch"])
  })

  it("reloads even if the cache-busting refetch rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline")))
    )
    const result = await runSwRecovery({ force: true })
    expect(result).toBe(true)
    expect(window.location.reload).toHaveBeenCalledOnce()
  })
})

describe("CSS watchdog inline script", () => {
  let watchdogScript: string
  let originalLocation: Location
  let originalStyleSheets: StyleSheetList
  let originalSessionStorage: Storage

  beforeAll(() => {
    const html = fs.readFileSync(path.resolve(__dirname, "../../index.html"), "utf-8")
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1].trim())
    watchdogScript = scripts.find((s) => s.includes("sw-recovery-attempts") && s.includes("document.styleSheets")) ?? ""
    if (!watchdogScript) throw new Error("CSS watchdog inline script not found in index.html")
  })

  beforeEach(() => {
    originalLocation = window.location
    originalStyleSheets = document.styleSheets
    originalSessionStorage = window.sessionStorage
    sessionStorage.clear()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    Object.defineProperty(window, "location", { configurable: true, value: originalLocation })
    Object.defineProperty(document, "styleSheets", { configurable: true, value: originalStyleSheets })
    Object.defineProperty(window, "sessionStorage", { configurable: true, value: originalSessionStorage })
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    sessionStorage.clear()
  })

  function execWatchdog({
    styleSheets = [] as unknown as StyleSheetList,
    resources = [{ initiatorType: "link", name: "/assets/index-AbC123.css", responseEnd: 1000 }],
    sessionStorage: sessionStorageOverride,
    serviceWorker = { getRegistrations: vi.fn(() => Promise.resolve([])) },
    caches = { keys: vi.fn(() => Promise.resolve([])), delete: vi.fn(() => Promise.resolve(true)) },
    fetch = vi.fn(() => Promise.resolve(new Response(""))),
  }: {
    styleSheets?: StyleSheetList
    resources?: Array<{ initiatorType: string; name: string; responseEnd: number }>
    sessionStorage?: Storage
    serviceWorker?: { getRegistrations: ReturnType<typeof vi.fn> }
    caches?: { keys: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> }
    fetch?: ReturnType<typeof vi.fn>
  } = {}) {
    const reload = vi.fn()
    Object.defineProperty(window, "location", { configurable: true, value: { ...originalLocation, reload } })
    Object.defineProperty(document, "styleSheets", { configurable: true, value: styleSheets })
    vi.spyOn(performance, "getEntriesByType").mockReturnValue(resources as unknown as PerformanceEntryList)
    if (sessionStorageOverride) {
      Object.defineProperty(window, "sessionStorage", { configurable: true, value: sessionStorageOverride })
    }
    vi.stubGlobal("navigator", { serviceWorker })
    vi.stubGlobal("caches", caches)
    vi.stubGlobal("fetch", fetch)

    const run = new Function(watchdogScript)
    run()

    return {
      reload,
      advance: (ms: number) => vi.advanceTimersByTime(ms),
      getRegistrations: serviceWorker.getRegistrations,
      cachesKeys: caches.keys,
      cachesDelete: caches.delete,
      fetch,
    }
  }

  it("reloads when styles are missing and a CSS request has completed", () => {
    const { reload, advance } = execWatchdog()
    advance(3000)
    expect(reload).toHaveBeenCalledOnce()
    expect(sessionStorage.getItem("sw-recovery-attempts")).toBe("1")
    expect(sessionStorage.getItem("sw-recovery-last")).not.toBeNull()
  })

  it("waits for in-flight CSS before deciding to reload", () => {
    const getEntriesSpy = vi.spyOn(performance, "getEntriesByType")
    getEntriesSpy
      .mockReturnValueOnce([] as unknown as PerformanceEntryList)
      .mockReturnValueOnce([
        { initiatorType: "link", name: "/assets/index-AbC123.css", responseEnd: 1000 },
      ] as unknown as PerformanceEntryList)
    const { reload, advance } = execWatchdog({ resources: [] })

    advance(3000)
    expect(reload).not.toHaveBeenCalled()
    advance(3000)
    expect(reload).toHaveBeenCalledOnce()
  })

  it("does not reload when styles loaded", () => {
    const styleSheets = [{ cssRules: [{ length: 1 }] }] as unknown as StyleSheetList
    const { reload, advance } = execWatchdog({ styleSheets, resources: [] })
    advance(3000)
    expect(reload).not.toHaveBeenCalled()
  })

  it("clears the counter on a healthy load once the cooldown has passed", () => {
    sessionStorage.setItem("sw-recovery-attempts", "1")
    sessionStorage.setItem("sw-recovery-last", String(Date.now() - 120_000))
    const styleSheets = [{ cssRules: [{ length: 1 }] }] as unknown as StyleSheetList
    const { reload, advance } = execWatchdog({ styleSheets, resources: [] })
    advance(3000)
    expect(reload).not.toHaveBeenCalled()
    expect(sessionStorage.getItem("sw-recovery-attempts")).toBeNull()
    expect(sessionStorage.getItem("sw-recovery-last")).toBeNull()
  })

  it("stops at the shared attempt cap", () => {
    sessionStorage.setItem("sw-recovery-attempts", "2")
    const { reload, advance } = execWatchdog()
    advance(3000)
    expect(reload).not.toHaveBeenCalled()
  })

  it("does not unregister service workers, delete caches, or fetch on automatic recovery", () => {
    const { reload, advance, getRegistrations, cachesKeys, cachesDelete, fetch: fetchMock } = execWatchdog()
    advance(3000)
    expect(reload).toHaveBeenCalledOnce()
    expect(getRegistrations).not.toHaveBeenCalled()
    expect(cachesKeys).not.toHaveBeenCalled()
    expect(cachesDelete).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("does not reload when sessionStorage is denied", () => {
    const deniedStorage = {
      getItem: vi.fn(() => {
        throw new DOMException("Denied", "SecurityError")
      }),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
      get length() {
        return 0
      },
      key: vi.fn(() => null),
    } as unknown as Storage
    const { reload, advance } = execWatchdog({ sessionStorage: deniedStorage })
    advance(3000)
    expect(reload).not.toHaveBeenCalled()
  })
})
