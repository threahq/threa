import { ACCOUNT_ASSERTION_HEADER } from "@threahq/types"
import type { ThreaDatabase } from "../db/database"
import { SW_MSG_PREFETCH_INBOX } from "./sw-messages"
import { appendPrefetch, type PrefetchPayload } from "../db/prefetch-inbox"
import { applyPrefetch } from "./sw-prefetch-inbox"

// Push bootstrap pre-fetch — warm stream data so it's instant on notification tap
// (stream: the account database, or the inbox the app drains into it; workspace: the Cache API entry served by the SW fetch
// interceptor to a page with no local state). Lives outside sw.ts so unit tests
// can drive it without a ServiceWorkerGlobalScope; sw.ts wires it to the
// push/message/sync events.

/** Cache name for pre-fetched workspace bootstrap responses triggered by push or background sync. */
export const PUSH_BOOTSTRAP_CACHE = "push-bootstrap"

/** Cache name used to persist pending Background Sync targets across SW restarts. */
export const PENDING_SYNC_CACHE = "pending-sync"

/** Single sync tag for bootstrap refresh — browsers coalesce repeat registrations under the same tag. */
export const BOOTSTRAP_SYNC_TAG = "threa-bootstrap-refresh"

/** Cache key for the persisted sync target. Last write wins; only the most recent target is replayed. */
export const PENDING_SYNC_KEY = `/_sync/${BOOTSTRAP_SYNC_TAG}`

/** Regex matching workspace bootstrap API paths. */
export const WORKSPACE_BOOTSTRAP_PATH_RE = /^\/api\/workspaces\/[^/]+\/bootstrap$/

/**
 * Query flag marking a bootstrap request that must not be answered from the
 * pre-fetched copy. Carried in the URL rather than only as `cache: "no-store"`
 * because how faithfully `Request.cache` reaches a service worker's fetch
 * handler varies by engine — and the browsers where it is least certain are
 * phones, which are exactly the devices this protects. A query flag cannot be
 * normalised away.
 */
export const BOOTSTRAP_FRESH_PARAM = "fresh"

/**
 * Query flag naming the account a bootstrap request is made as. A workspace
 * snapshot is viewer-specific — stream membership, read state, DM names — so
 * the cache is keyed by owner as well as URL and a request only ever reads the
 * entry belonging to the account making it. Carried in the URL for the same
 * reason as {@link BOOTSTRAP_FRESH_PARAM}: it reaches the service worker's
 * fetch handler on every engine, and it cannot be normalised away.
 */
export const BOOTSTRAP_ACCOUNT_PARAM = "account"

/**
 * The cache key: the plain URL, minus the freshness flag, plus the owning
 * account. Entries written before the key carried an owner (a previous SW
 * version) are unreachable under it and are never served.
 */
function bootstrapCacheKey(url: string, workosUserId: string): string {
  const parsed = new URL(url)
  parsed.searchParams.delete(BOOTSTRAP_FRESH_PARAM)
  parsed.searchParams.set(BOOTSTRAP_ACCOUNT_PARAM, workosUserId)
  return parsed.toString()
}

/**
 * Answer a workspace-bootstrap request, consuming the pre-fetched copy when
 * there is one. Split out of the sw.ts fetch listener so it can be driven with
 * a fake Cache — jsdom has no CacheStorage.
 *
 * A fresh request means the caller is about to treat the snapshot as the
 * authority for everything at or below a sync head it read separately. This
 * entry was captured when the tab last hid, so it can predate that head;
 * serving it would strand every entry in between. Delete rather than skip, so a
 * later request carrying the same expectation can't be handed the same copy.
 */
export async function respondToBootstrapRequest(
  request: Request,
  cache: Cache,
  fetchImpl: (request: Request) => Promise<Response>
): Promise<Response> {
  const owner = new URL(request.url).searchParams.get(BOOTSTRAP_ACCOUNT_PARAM)
  // A request that doesn't name its account can't be shown a snapshot: the
  // entry was captured for one specific viewer, and the session cookie the
  // request carries may now belong to another. A page from before this
  // parameter existed keeps working — it just goes to the network.
  if (!owner) return fetchImpl(request)

  const key = bootstrapCacheKey(request.url, owner)
  if (request.cache === "no-store" || new URL(request.url).searchParams.has(BOOTSTRAP_FRESH_PARAM)) {
    await cache.delete(key)
    return fetchImpl(request)
  }
  const cached = await cache.match(key)
  if (cached) {
    // One-shot: serve and delete so the next fetch gets fresh data.
    void cache.delete(key)
    return cached
  }
  return fetchImpl(request)
}

/**
 * Delete snapshots captured before the cache key named an owner. They are
 * already unreachable (every lookup carries an account) and a bootstrap is a
 * copy of the server, so nothing is lost — but left alone they sit in the
 * origin's storage, one account's workspace readable to anyone on the device.
 */
export async function pruneUnownedBootstrapSnapshots(cache: Cache): Promise<void> {
  for (const request of await cache.keys()) {
    if (!new URL(request.url).searchParams.has(BOOTSTRAP_ACCOUNT_PARAM)) await cache.delete(request)
  }
}

export interface BootstrapSyncTarget {
  workspaceId: string
  streamId: string | null
  messageId: string | null
  /**
   * Recipient account's WorkOS user id — selects the per-account IndexedDB
   * (`accountDbName`). The worker has no AccountScope, so without it there is
   * no way to know which account's database to warm: the IDB half of the
   * prefetch is skipped (writing to the pre-auth default DB would warm a
   * database the app never reads once signed in). Null on targets persisted by
   * older SW versions.
   */
  workosUserId: string | null
}

// Account databases opened by this worker, keyed by database name. The worker
// never calls setActiveDb (that pointer belongs to the main thread's
// AccountScope), so it must open the account's database explicitly.
const accountDbs = new Map<string, ThreaDatabase>()

async function openAccountDb(workosUserId: string): Promise<ThreaDatabase> {
  // Dynamic import keeps Dexie off the SW critical path (push display must not
  // wait on it). The SW shares the origin — and therefore the databases — with
  // the main thread.
  const { ThreaDatabase: Database, accountDbName } = await import("../db/database")
  const name = accountDbName(workosUserId)
  let inst = accountDbs.get(name)
  if (!inst) {
    inst = new Database(name, workosUserId)
    accountDbs.set(name, inst)
  }
  return inst
}

/**
 * Fetch options for a prefetch made on behalf of `workosUserId`. The owner check
 * reads the cookie once and the account can move before these requests land;
 * stating the recipient makes the server refuse rather than answer as whoever
 * the cookie names now, so no response is written under the wrong account's key.
 */
function prefetchInit(workosUserId: string): RequestInit {
  return { credentials: "include", headers: { [ACCOUNT_ASSERTION_HEADER]: workosUserId } }
}

/** Where a prefetch lands, split out so tests can stand in for Web Locks and the window clients. */
export interface PrefetchStore {
  /** Without Web Locks no tab can run SQLite storage, so IndexedDB is the primary copy. */
  sqliteCapable: boolean
  appendPrefetch(dbName: string, payload: PrefetchPayload): Promise<void>
  writeNative(workosUserId: string, payload: PrefetchPayload): Promise<void>
  announce(dbName: string): Promise<void>
}

interface WindowClients {
  clients?: {
    matchAll(options: {
      type: "window"
      includeUncontrolled: boolean
    }): Promise<Array<{ postMessage(m: unknown): void }>>
  }
}

export function browserPrefetchStore(): PrefetchStore {
  return {
    sqliteCapable: typeof navigator !== "undefined" && navigator.locks !== undefined,
    appendPrefetch,
    writeNative: async (workosUserId, payload) => applyPrefetch(await openAccountDb(workosUserId), payload),
    announce: async (dbName) => {
      const windows = await (self as unknown as WindowClients).clients?.matchAll({
        type: "window",
        includeUncontrolled: true,
      })
      for (const client of windows ?? []) client.postMessage({ type: SW_MSG_PREFETCH_INBOX, dbName })
    },
  }
}

/**
 * Queues the prefetch for the app to apply through its own write path, onto
 * SQLite or IndexedDB, whichever holds the database; this worker writes the
 * database itself only where no tab can run SQLite storage.
 */
export async function storePrefetch(
  workosUserId: string,
  payload: PrefetchPayload,
  store: PrefetchStore
): Promise<void> {
  if (!store.sqliteCapable) return store.writeNative(workosUserId, payload)
  const { accountDbName } = await import("../db/database")
  const dbName = accountDbName(workosUserId)
  await store.appendPrefetch(dbName, payload)
  await store.announce(dbName)
}

/**
 * Pre-fetch events around a specific message so it's available in IDB
 * when the user taps the push notification. Best-effort.
 */
async function prefetchEventsAround(
  workosUserId: string,
  workspaceId: string,
  streamId: string,
  messageId: string,
  store: PrefetchStore
): Promise<void> {
  try {
    const url = `/api/workspaces/${workspaceId}/streams/${streamId}/events/around?messageId=${messageId}&limit=30`
    const response = await fetch(url, prefetchInit(workosUserId))
    if (!response.ok) return

    const body = await response.json()
    const around = body.data ?? body
    if (!(around?.events?.length > 0)) return
    await storePrefetch(
      workosUserId,
      { kind: "eventsAround", workspaceId, streamId, fetchedAt: Date.now(), around },
      store
    )
  } catch {
    // Best-effort
  }
}

async function prefetchStreamBootstrap(
  workosUserId: string,
  workspaceId: string,
  streamId: string,
  store: PrefetchStore
): Promise<void> {
  const url = `/api/workspaces/${workspaceId}/streams/${streamId}/bootstrap`
  const response = await fetch(url, prefetchInit(workosUserId))
  if (!response.ok) return

  // Warm IndexedDB so useLiveQuery renders the stream instantly when the user
  // taps the notification. We deliberately do NOT cache the response for the
  // fetch interceptor to replay: the page's own bootstrap GET passes through to
  // the network and applies the fresh result on top of this warm paint
  // (stale-while-revalidate), so replaying a snapshot captured before later
  // activity would only reintroduce staleness. Best-effort: errors are swallowed.
  try {
    const body = await response.json()
    const bootstrap = body.data ?? body
    if (!bootstrap?.events?.length) return
    await storePrefetch(
      workosUserId,
      { kind: "streamBootstrap", workspaceId, streamId, fetchedAt: Date.now(), bootstrap },
      store
    )
  } catch {
    // Best-effort — normal fetch path takes over if this fails
  }
}

/**
 * Pre-fetch the workspace bootstrap into the push cache. The SW's fetch
 * interceptor serves it only to a page with nothing local (no sync cursor, no
 * cached workspace): a page that has either asks with `?fresh=1`, which deletes
 * this copy rather than reading it, because a snapshot captured before the
 * device went away would stamp the cursor below entries already applied.
 *
 * Errors propagate so the `sync` event handler sees the rejection and the
 * browser retries Background Sync. Inline callers (push handler, no-sync
 * fallback) catch separately and treat failures as best-effort.
 *
 * Unlike stream bootstrap, we don't seed IDB here — the workspace bootstrap
 * apply pipeline is large and lives in workspace-sync; running it from the SW
 * would duplicate that surface.
 */
async function prefetchWorkspaceBootstrap(workosUserId: string, workspaceId: string): Promise<void> {
  const url = `/api/workspaces/${workspaceId}/bootstrap`
  const response = await fetch(url, prefetchInit(workosUserId))
  if (!response.ok) return
  const cache = await caches.open(PUSH_BOOTSTRAP_CACHE)
  await cache.put(bootstrapCacheKey(new URL(url, self.location.origin).toString(), workosUserId), response)
}

/**
 * The account the worker's session cookie currently authenticates as, or null
 * when that can't be established.
 *
 * The worker fetches with whatever cookie the browser holds, which is the
 * *active* account — not necessarily the account a push was addressed to. Every
 * prefetch is therefore gated on the two being the same: otherwise the response
 * is the active account's view of the workspace and writing it under the
 * recipient's database or cache key would hand one account the other's data.
 */
export async function resolveCredentialOwner(): Promise<string | null> {
  try {
    const response = await fetch("/api/auth/me", { credentials: "include" })
    if (!response.ok) return null
    const user = (await response.json()) as { id?: unknown }
    return typeof user?.id === "string" ? user.id : null
  } catch {
    return null
  }
}

/**
 * Run a bootstrap prefetch for the given target. Pure-ish: does network + cache
 * + IDB writes but no event-listener wiring, so unit tests can drive it directly.
 *
 * Stream prefetch runs first because that's the user's perceived loading path
 * after tapping a notification; workspace prefetch is the ambient sidebar
 * freshness pass that can land slightly later without affecting the open-stream
 * experience.
 *
 * Both halves require `workosUserId` (see BootstrapSyncTarget) and a session
 * cookie that authenticates as that same account.
 */
export async function runBootstrapSync(
  target: BootstrapSyncTarget,
  store: PrefetchStore = browserPrefetchStore()
): Promise<void> {
  // No named recipient (a target persisted by an older SW version), or the
  // browser is currently signed in as somebody else: skip rather than warm one
  // account's storage with another's data. The tap path then loads normally.
  if (!target.workosUserId) return
  if ((await resolveCredentialOwner()) !== target.workosUserId) return

  if (target.streamId) {
    await prefetchStreamBootstrap(target.workosUserId, target.workspaceId, target.streamId, store)
    if (target.messageId) {
      await prefetchEventsAround(target.workosUserId, target.workspaceId, target.streamId, target.messageId, store)
    }
  }
  await prefetchWorkspaceBootstrap(target.workosUserId, target.workspaceId)
}

/**
 * Persist the sync target and register a Background Sync. The browser fires the
 * `sync` event once connectivity is available and retries on failure, so the
 * prefetch survives flaky networks and SW termination.
 *
 * Browsers without Background Sync (Safari, Firefox) throw on register — we
 * fall through to running the prefetch immediately. Inline runs delete the
 * persisted target after the run so a sync-capable browser that gains support
 * later (or a leftover entry from a previous SW version) doesn't replay stale.
 */
export async function queueBootstrapSync(
  target: BootstrapSyncTarget,
  registration: ServiceWorkerRegistration
): Promise<void> {
  const cache = await caches.open(PENDING_SYNC_CACHE)
  await cache.put(
    PENDING_SYNC_KEY,
    new Response(JSON.stringify(target), { headers: { "Content-Type": "application/json" } })
  )

  const reg = registration as ServiceWorkerRegistration & {
    sync?: { register: (tag: string) => Promise<void> }
  }
  if (reg.sync) {
    try {
      await reg.sync.register(BOOTSTRAP_SYNC_TAG)
      return
    } catch {
      // Fall through to immediate prefetch below
    }
  }

  try {
    await runBootstrapSync(target)
  } finally {
    void caches.open(PENDING_SYNC_CACHE).then((c) => c.delete(PENDING_SYNC_KEY))
  }
}

/**
 * Read back a target persisted by queueBootstrapSync. Targets written by older
 * SW versions predate `workosUserId`; normalize the missing field to null so
 * replay skips their IDB half instead of guessing a database.
 */
export function parsePersistedSyncTarget(raw: unknown): BootstrapSyncTarget | null {
  if (typeof raw !== "object" || raw === null) return null
  const t = raw as Partial<BootstrapSyncTarget>
  if (typeof t.workspaceId !== "string") return null
  if (t.streamId != null && typeof t.streamId !== "string") return null
  if (t.messageId != null && typeof t.messageId !== "string") return null
  if (t.workosUserId != null && typeof t.workosUserId !== "string") return null
  return {
    workspaceId: t.workspaceId,
    streamId: t.streamId ?? null,
    messageId: t.messageId ?? null,
    workosUserId: t.workosUserId ?? null,
  }
}
