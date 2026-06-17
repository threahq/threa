import { describe, expect, it, vi } from "vitest"
import { clearAllDecrypted, createDecryptedCache, registerDecryptedCache, type DecryptStatus } from "../decrypted-cache"

interface Entry {
  status: DecryptStatus
  value: string | null
}

function makeCache(overrides: Partial<Parameters<typeof createDecryptedCache<Entry>>[0]> = {}) {
  return createDecryptedCache<Entry>({
    subscription: "per-key",
    pending: () => ({ status: "pending", value: null }),
    ...overrides,
  })
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe("createDecryptedCache", () => {
  it("caches the settled entry and short-circuits a later request", async () => {
    const cache = makeCache()
    const run = vi.fn().mockResolvedValue({ status: "decrypted", value: "hi" } satisfies Entry)
    await cache.request("k", run)
    expect(cache.peek("k")).toEqual({ status: "decrypted", value: "hi" })
    await cache.request("k", run)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("coalesces concurrent requests for the same key into one decrypt", async () => {
    const cache = makeCache()
    const run = vi.fn().mockResolvedValue({ status: "decrypted", value: "x" } satisfies Entry)
    await Promise.all([cache.request("k", run), cache.request("k", run), cache.request("k", run)])
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("treats a failed entry as terminal when retryFailed is false", async () => {
    const cache = makeCache({ retryFailed: false })
    const run = vi.fn().mockResolvedValue({ status: "failed", value: null } satisfies Entry)
    await cache.request("k", run)
    await cache.request("k", run)
    expect(cache.peek("k")).toEqual({ status: "failed", value: null })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("re-attempts a failed entry when retryFailed is true", async () => {
    const cache = makeCache({ retryFailed: true })
    const run = vi.fn().mockResolvedValue({ status: "failed", value: null } satisfies Entry)
    await cache.request("k", run)
    await cache.request("k", run)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it("drops an in-flight decrypt that resolves after clear (no plaintext past lock)", async () => {
    const cache = makeCache()
    const d = deferred<Entry>()
    const pending = cache.request("k", () => d.promise)
    expect(cache.peek("k")).toEqual({ status: "pending", value: null })

    cache.clear()
    expect(cache.peek("k")).toBeUndefined()

    d.resolve({ status: "decrypted", value: "secret" })
    await pending
    expect(cache.peek("k")).toBeUndefined()
  })

  it("recovers after a rejected decrypt (no sticky in-flight)", async () => {
    const cache = makeCache()
    await expect(cache.request("k", () => Promise.reject(new Error("boom")))).rejects.toThrow("boom")
    // The rejected attempt must not leave a stuck pending entry or in-flight promise.
    expect(cache.peek("k")).toBeUndefined()
    await cache.request("k", async () => ({ status: "decrypted", value: "recovered" }))
    expect(cache.peek("k")).toEqual({ status: "decrypted", value: "recovered" })
  })

  it("primes a known entry and skips a later decrypt", async () => {
    const cache = makeCache()
    cache.prime("k", { status: "decrypted", value: "seed" })
    expect(cache.peek("k")).toEqual({ status: "decrypted", value: "seed" })
    const run = vi.fn().mockResolvedValue({ status: "decrypted", value: "crypto" } satisfies Entry)
    await cache.request("k", run)
    expect(run).not.toHaveBeenCalled()
  })

  it("honors skipPrime to avoid clobbering a decrypted entry", () => {
    const cache = makeCache({ skipPrime: (existing) => existing?.status === "decrypted" })
    cache.prime("k", { status: "decrypted", value: "first" })
    cache.prime("k", { status: "decrypted", value: "second" })
    expect(cache.peek("k")).toEqual({ status: "decrypted", value: "first" })
  })

  it("notifies a per-key listener for its key only, plus any global listener", async () => {
    const cache = makeCache({ subscription: "per-key" })
    const keyListener = vi.fn()
    const otherListener = vi.fn()
    const globalListener = vi.fn()
    cache.subscribe("k", keyListener)
    cache.subscribe("other", otherListener)
    cache.subscribe(null, globalListener)
    await cache.request("k", async () => ({ status: "decrypted", value: "x" }))
    expect(keyListener).toHaveBeenCalledTimes(1)
    expect(globalListener).toHaveBeenCalledTimes(1)
    expect(otherListener).not.toHaveBeenCalled()
  })

  it("bumps the version on every change", async () => {
    const cache = makeCache()
    const before = cache.getVersion()
    await cache.request("k", async () => ({ status: "decrypted", value: "x" }))
    expect(cache.getVersion()).toBeGreaterThan(before)
  })

  it("evicts the least-recently-touched entry past the lru cap", async () => {
    const cache = makeCache({ lru: 2 })
    await cache.request("a", async () => ({ status: "decrypted", value: "a" }))
    await cache.request("b", async () => ({ status: "decrypted", value: "b" }))
    await cache.request("c", async () => ({ status: "decrypted", value: "c" }))
    expect(cache.peek("a")).toBeUndefined()
    expect(cache.peek("c")).toEqual({ status: "decrypted", value: "c" })
  })

  it("a global-subscription cache notifies its global listener on clear", async () => {
    const cache = makeCache({ subscription: "global" })
    await cache.request("k", async () => ({ status: "decrypted", value: "x" }))
    const listener = vi.fn()
    cache.subscribe(null, listener)
    cache.clear()
    expect(cache.peek("k")).toBeUndefined()
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe("lock-clear registry", () => {
  it("clearAllDecrypted clears an auto-registered cache instance", async () => {
    const cache = makeCache()
    await cache.request("k", async () => ({ status: "decrypted", value: "x" }))
    expect(cache.peek("k")).toEqual({ status: "decrypted", value: "x" })
    clearAllDecrypted()
    expect(cache.peek("k")).toBeUndefined()
  })

  it("clearAllDecrypted invokes an explicitly registered clear", () => {
    const clear = vi.fn()
    registerDecryptedCache(clear)
    clearAllDecrypted()
    expect(clear).toHaveBeenCalled()
  })

  it("runs every registered clear even when one throws, then surfaces the failure", async () => {
    const cache = makeCache()
    await cache.request("k", async () => ({ status: "decrypted", value: "x" }))
    // Throw once so the registered clear doesn't poison later clearAllDecrypted calls.
    let armed = true
    registerDecryptedCache(() => {
      if (armed) {
        armed = false
        throw new Error("boom")
      }
    })
    expect(() => clearAllDecrypted()).toThrow()
    // The healthy cache was still cleared despite the sibling throwing.
    expect(cache.peek("k")).toBeUndefined()
  })
})
