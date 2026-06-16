/**
 * Shared in-memory cache primitive for decrypted E2E content.
 *
 * Every encrypted field (message bodies, stream names, …) decrypts on demand and
 * holds the plaintext in memory only — ciphertext stays at rest in IDB, plaintext
 * is cleared on lock (E2EE-4). Each field re-implemented the same lifecycle: a
 * Map keyed by a ciphertext id, in-flight dedup, a lock-epoch guard so a decrypt
 * resolving after lock can't write plaintext back, a subscribe/version signal,
 * and a clear. This factory captures that lifecycle once; `decrypt-cache` and
 * `stream-name-cache` are thin instances over it.
 *
 * Two subscription models share the core: "global" (one version counter; few
 * keys, e.g. names — the overlay maps the whole list) and "per-key" (per-key
 * listener sets; hundreds of keys, e.g. message bodies — a global bump would
 * re-render every row). A global version + global listeners exist in BOTH modes
 * (batch readers watch them); "per-key" additionally maintains per-key sets.
 *
 * Every instance auto-registers its `clear` in the module lock-clear registry, so
 * a new encrypted field cannot forget a clear site: `clearAllDecrypted()` (called
 * on lock / account switch) wipes them all. A cache can only hold plaintext if its
 * module is loaded, and loading registers it — so any cache with data is cleared.
 */

export type DecryptStatus = "pending" | "decrypted" | "failed"

interface BaseEntry {
  status: DecryptStatus
}

export interface DecryptedCache<E extends BaseEntry> {
  /** The raw cached entry, or undefined if this key was never requested/primed. */
  peek(key: string): E | undefined
  /**
   * Decrypt-and-cache for a key, deduping concurrent callers. Guards the
   * write-back against a `clear()` (lock) or a concurrent `prime`/`invalidate`
   * that landed mid-flight. Returns the settled entry the decrypt produced — even
   * when the guard dropped the write-back — so callers can react to the result.
   */
  request(key: string, run: () => Promise<E>): Promise<E>
  /** Seed a known entry without crypto (optimistic echo / local rename). */
  prime(key: string, entry: E): void
  /** Drop a single key (entry + in-flight) and notify, so a reused id can be replaced. */
  invalidate(key: string): void
  /** Subscribe to changes for one key, or — with `key === null` — to any change. */
  subscribe(key: string | null, listener: () => void): () => void
  /** Monotonic version, bumped on every change; the snapshot batch readers watch. */
  getVersion(): number
  /** Drop everything and bump the lock epoch so in-flight decrypts can't write back. */
  clear(): void
}

export interface CreateDecryptedCacheOptions<E extends BaseEntry> {
  subscription: "global" | "per-key"
  /** Cap on cached entries; least-recently-touched evicted past it. Unbounded if omitted. */
  lru?: number
  /**
   * Whether a later `request` re-attempts after a `failed` entry. Message bodies
   * treat failure as terminal (false). Stream names treat a null open as
   * transient — locked, or a wrap not yet resolvable — and retry (true).
   */
  retryFailed?: boolean
  /** The placeholder inserted while a decrypt is in flight. */
  pending: () => E
  /** When this returns true for the current entry, `prime` is a no-op (idempotency / don't-clobber). */
  skipPrime?: (existing: E | undefined, next: E) => boolean
}

const lockClearRegistry = new Set<() => void>()

/** Register a cache's clear so `clearAllDecrypted()` wipes it on lock. */
export function registerDecryptedCache(clear: () => void): void {
  lockClearRegistry.add(clear)
}

/** Clear every registered cache — the single lock / account-switch boundary. */
export function clearAllDecrypted(): void {
  for (const clear of lockClearRegistry) clear()
}

export function createDecryptedCache<E extends BaseEntry>(options: CreateDecryptedCacheOptions<E>): DecryptedCache<E> {
  const { subscription, lru, retryFailed = false, pending, skipPrime } = options

  const entries = new Map<string, E>()
  const inflight = new Map<string, Promise<E>>()
  const globalListeners = new Set<() => void>()
  const keyListeners = subscription === "per-key" ? new Map<string, Set<() => void>>() : null

  let version = 0
  // Bumped by clear() so an in-flight decrypt that resolves after a lock detects
  // it's stale and refuses to write plaintext back (no leak past the lock).
  let generation = 0

  function emit(key: string): void {
    version++
    for (const listener of globalListeners) listener()
    if (!keyListeners) return
    const set = keyListeners.get(key)
    if (!set) return
    for (const listener of set) listener()
  }

  function touch(key: string, entry: E): void {
    // Map iteration order is insertion order; re-inserting bumps it to MRU.
    entries.delete(key)
    entries.set(key, entry)
    if (lru !== undefined && entries.size > lru) {
      const oldest = entries.keys().next().value
      if (oldest !== undefined) entries.delete(oldest)
    }
  }

  function peek(key: string): E | undefined {
    return entries.get(key)
  }

  function request(key: string, run: () => Promise<E>): Promise<E> {
    const existing = entries.get(key)
    if (existing) {
      if (existing.status === "decrypted") return Promise.resolve(existing)
      if (existing.status === "failed" && !retryFailed) return Promise.resolve(existing)
      // pending, or a retryable failed entry → fall through to (re-)decrypt.
    }
    const current = inflight.get(key)
    if (current) return current

    touch(key, pending())
    const startGeneration = generation
    // A holder so the async body can compare against its own promise identity
    // (`holder.promise` is assigned synchronously below, before any await resolves).
    const holder: { promise?: Promise<E> } = {}
    holder.promise = (async (): Promise<E> => {
      const entry = await run()
      // Dropped if the cache was cleared (lock / account switch) mid-flight —
      // writing plaintext back would leak it past the lock boundary.
      if (startGeneration !== generation) return entry
      // A concurrent prime/invalidate may have replaced this key's slot while we
      // decrypted; only the current in-flight writes back, so a stale decrypt
      // can't clobber freshly-authored content.
      if (inflight.get(key) !== holder.promise) return entry
      touch(key, entry)
      inflight.delete(key)
      emit(key)
      return entry
    })()
    inflight.set(key, holder.promise)
    return holder.promise
  }

  function prime(key: string, entry: E): void {
    if (skipPrime?.(entries.get(key), entry)) return
    touch(key, entry)
    inflight.delete(key)
    emit(key)
  }

  function invalidate(key: string): void {
    const had = entries.delete(key)
    const wasInflight = inflight.delete(key)
    if (had || wasInflight) emit(key)
  }

  function subscribe(key: string | null, listener: () => void): () => void {
    if (key === null || !keyListeners) {
      globalListeners.add(listener)
      return () => {
        globalListeners.delete(listener)
      }
    }
    let set = keyListeners.get(key)
    if (!set) {
      set = new Set()
      keyListeners.set(key, set)
    }
    set.add(listener)
    return () => {
      const current = keyListeners.get(key)
      if (!current) return
      current.delete(listener)
      if (current.size === 0) keyListeners.delete(key)
    }
  }

  function getVersion(): number {
    return version
  }

  function clear(): void {
    generation++
    // Per-key subscribers re-render only when their own key emits, so notify each
    // previously-present key. A global cache fires one emit regardless.
    const keys = keyListeners ? Array.from(entries.keys()) : null
    entries.clear()
    inflight.clear()
    if (keys) {
      for (const key of keys) emit(key)
    } else {
      emit("")
    }
  }

  const api: DecryptedCache<E> = { peek, request, prime, invalidate, subscribe, getVersion, clear }
  registerDecryptedCache(clear)
  return api
}
