import { AuthorTypes, type LastMessagePreview, type StreamEvent } from "@threa/types"
import type { CachedEvent, ThreaDatabase } from "../db/database"
import { putEventsBounded } from "../db/event-writes"
import { writeSlotCarrier } from "../stores/slot-store"

// Push bootstrap pre-fetch — warm stream data so it's instant on notification tap
// (stream: IndexedDB; workspace: the Cache API entry served by the SW fetch
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

/** The cache is keyed on the plain URL; strip the flag before looking up. */
function bootstrapCacheKey(url: string): string {
  const parsed = new URL(url)
  parsed.searchParams.delete(BOOTSTRAP_FRESH_PARAM)
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
  const key = bootstrapCacheKey(request.url)
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
    inst = new Database(name)
    accountDbs.set(name, inst)
  }
  return inst
}

/** Find the most recent message_created event. Bootstrap events are ordered oldest → newest. */
function findLatestMessageEvent(events: StreamEvent[]): StreamEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].eventType === "message_created") return events[i]
  }
  return null
}

function buildPreviewFromEvent(event: StreamEvent): LastMessagePreview {
  const payload = (event.payload ?? {}) as { contentMarkdown?: string }
  return {
    authorId: event.actorId ?? "",
    authorType: event.actorType ?? AuthorTypes.USER,
    content: payload.contentMarkdown ?? "",
    createdAt: event.createdAt,
  }
}

/**
 * Pre-fetch events around a specific message so it's available in IDB
 * when the user taps the push notification. Best-effort.
 */
async function prefetchEventsAround(
  workosUserId: string,
  workspaceId: string,
  streamId: string,
  messageId: string
): Promise<void> {
  try {
    const url = `/api/workspaces/${workspaceId}/streams/${streamId}/events/around?messageId=${messageId}&limit=30`
    const response = await fetch(url, { credentials: "include" })
    if (!response.ok) return

    const body = await response.json()
    const data = body.data ?? body
    if (data?.events?.length > 0) {
      const now = Date.now()
      const [db, { sequenceToNum }] = await Promise.all([openAccountDb(workosUserId), import("../db/database")])
      await db.transaction("rw", [db.events, db.slots], async () => {
        await putEventsBounded(
          db.events,
          data.events.map((e: Record<string, unknown>) => ({
            ...e,
            workspaceId,
            _sequenceNum: sequenceToNum(e.sequence as string),
            _cachedAt: now,
          })) as CachedEvent[]
        )
        // Warm the pointer slots this prefetch exists to preserve; an
        // events-around window merges (it is not an authoritative snapshot).
        await writeSlotCarrier({ database: db, workspaceId, streamId, carrier: data, mode: "merge", cachedAt: now })
      })
    }
  } catch {
    // Best-effort
  }
}

async function prefetchStreamBootstrap(workosUserId: string, workspaceId: string, streamId: string): Promise<void> {
  const url = `/api/workspaces/${workspaceId}/streams/${streamId}/bootstrap`
  const response = await fetch(url, { credentials: "include" })
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

    const now = Date.now()
    const [db, { sequenceToNum }] = await Promise.all([openAccountDb(workosUserId), import("../db/database")])

    const events: StreamEvent[] = bootstrap.events
    const latestMessageEvent = findLatestMessageEvent(events)
    const derivedPreview = latestMessageEvent ? buildPreviewFromEvent(latestMessageEvent) : null

    // The stream bootstrap endpoint returns a plain Stream without
    // lastMessagePreview — a blind put would wipe the sidebar preview and
    // sink the stream into "Other". Merge via update() so lastMessagePreview
    // and membership-derived fields (notificationLevel) from
    // applyWorkspaceBootstrap survive.
    await db.transaction("rw", [db.events, db.streams, db.slots], async () => {
      await putEventsBounded(
        db.events,
        events.map((e) => ({
          ...e,
          workspaceId,
          _sequenceNum: sequenceToNum(e.sequence),
          _cachedAt: now,
        }))
      )

      // Warm the bootstrap's pointer slots in the same transaction; a cold
      // notification tap otherwise persists events but discards the pointer
      // state this store exists to preserve (Amendment A2). A replace prefetch
      // can land against a live scrolled-up session, so it scopes its delete
      // to the fetched window's events (B2) — out-of-window keys survive.
      await writeSlotCarrier(
        bootstrap.syncMode === "append"
          ? { database: db, workspaceId, streamId, carrier: bootstrap, mode: "merge", cachedAt: now }
          : {
              database: db,
              workspaceId,
              streamId,
              carrier: bootstrap,
              mode: "replace",
              windowEvents: events,
              cachedAt: now,
            }
      )

      if (!bootstrap.stream) return

      const patch: { _cachedAt: number; lastMessagePreview?: LastMessagePreview } = { _cachedAt: now }
      if (derivedPreview) patch.lastMessagePreview = derivedPreview

      const updated = await db.streams.update(bootstrap.stream.id, patch)
      if (updated === 0) {
        await db.streams.put({ ...bootstrap.stream, ...patch })
      }
    })
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
async function prefetchWorkspaceBootstrap(workspaceId: string): Promise<void> {
  const url = `/api/workspaces/${workspaceId}/bootstrap`
  const response = await fetch(url, { credentials: "include" })
  if (!response.ok) return
  const cache = await caches.open(PUSH_BOOTSTRAP_CACHE)
  await cache.put(url, response)
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
 * The IDB half requires `workosUserId` (see BootstrapSyncTarget); without it
 * only the workspace Cache API warm-up runs — that entry is keyed by URL and
 * fetched with the session cookie, so it needs no account routing.
 */
export async function runBootstrapSync(target: BootstrapSyncTarget): Promise<void> {
  if (target.streamId && target.workosUserId) {
    await prefetchStreamBootstrap(target.workosUserId, target.workspaceId, target.streamId)
    if (target.messageId) {
      await prefetchEventsAround(target.workosUserId, target.workspaceId, target.streamId, target.messageId)
    }
  }
  await prefetchWorkspaceBootstrap(target.workspaceId)
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
