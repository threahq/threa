import { AuthorTypes, type LastMessagePreview, type StreamEvent } from "@threahq/types"
import type { CachedEvent, CachedStream, ThreaDatabase } from "@/db/database"
import { putEventsBounded } from "@/db/event-writes"
import {
  PREFETCH_INBOX_MAX_AGE_MS,
  deletePrefetch,
  discardPrefetches,
  oldestPrefetch,
  prefetchInboxLockName,
  type PrefetchPayload,
} from "@/db/prefetch-inbox"
import { SW_MSG_PREFETCH_INBOX } from "@/lib/sw-messages"
import { writeSlotCarrier } from "@/stores/slot-store"

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

/** Writes one prefetch in one transaction. Applying it again, as a drain interrupted after the commit does, changes nothing. */
export async function applyPrefetch(database: ThreaDatabase, payload: PrefetchPayload): Promise<void> {
  const { workspaceId, streamId, fetchedAt: cachedAt } = payload
  const { sequenceToNum } = await import("@/db/database")
  const toCached = (events: StreamEvent[]): CachedEvent[] =>
    events.map((e) => ({ ...e, workspaceId, _sequenceNum: sequenceToNum(e.sequence), _cachedAt: cachedAt }))

  if (payload.kind === "eventsAround") {
    const { around } = payload
    await database.transaction("rw", [database.events, database.slots], async () => {
      await putEventsBounded(database.events, toCached(around.events))
      // Warm the pointer slots this prefetch exists to preserve; an
      // events-around window merges (it is not an authoritative snapshot).
      await writeSlotCarrier({ database, workspaceId, streamId, carrier: around, mode: "merge", cachedAt })
    })
    return
  }

  const { bootstrap } = payload
  const { events } = bootstrap
  const latestMessageEvent = findLatestMessageEvent(events)
  const derivedPreview = latestMessageEvent ? buildPreviewFromEvent(latestMessageEvent) : null

  // The stream bootstrap endpoint returns a plain Stream without
  // lastMessagePreview — a blind put would wipe the sidebar preview and
  // sink the stream into "Other". Merge via update() so lastMessagePreview
  // and membership-derived fields (notificationLevel) from
  // applyWorkspaceBootstrap survive.
  await database.transaction("rw", [database.events, database.streams, database.slots], async () => {
    await putEventsBounded(database.events, toCached(events))

    // Warm the bootstrap's pointer slots in the same transaction; a cold
    // notification tap otherwise persists events but discards the pointer
    // state this store exists to preserve (Amendment A2). A replace prefetch
    // can land against a live scrolled-up session, so it scopes its delete
    // to the fetched window's events (B2) — out-of-window keys survive.
    await writeSlotCarrier(
      bootstrap.syncMode === "append"
        ? { database, workspaceId, streamId, carrier: bootstrap, mode: "merge", cachedAt }
        : { database, workspaceId, streamId, carrier: bootstrap, mode: "replace", windowEvents: events, cachedAt }
    )

    if (!bootstrap.stream) return

    const patch: { _cachedAt: number; lastMessagePreview?: LastMessagePreview } = { _cachedAt: cachedAt }
    if (derivedPreview) patch.lastMessagePreview = derivedPreview

    const updated = await database.streams.update([workspaceId, bootstrap.stream.id], patch)
    if (updated === 0) {
      await database.streams.put({ ...bootstrap.stream, ...patch, workspaceId } as CachedStream)
    }
  })
}

/**
 * Applies `database`'s prefetches oldest first through its own write path, so
 * they reach SQLite under read-write storage and IndexedDB otherwise. An entry
 * leaves the inbox only once its write committed; one tab drains at a time,
 * so no entry lands after a later one.
 */
export function drainPrefetchInbox(database: ThreaDatabase, now: () => number = Date.now): Promise<void> {
  const drain = async () => {
    for (;;) {
      const entry = await oldestPrefetch(database.name)
      if (!entry) return
      const { payload } = entry
      if (payload.kind !== "streamBootstrap" && payload.kind !== "eventsAround") {
        console.error("Dropping a service-worker prefetch of unknown kind", payload)
      } else if (payload.fetchedAt >= now() - PREFETCH_INBOX_MAX_AGE_MS) {
        await applyPrefetch(database, payload)
      }
      await deletePrefetch(entry.key)
    }
  }
  if (!navigator.locks) return drain()
  return navigator.locks.request(prefetchInboxLockName(database.name), drain)
}

/**
 * Drains the inbox on every open, after the storage mode routes requests and
 * before Dexie admits any of the app's transactions, so a prefetch never lands
 * over a write made after it. A drain that fails discards what is left rather
 * than holding the open or landing later over newer rows.
 */
export function drainPrefetchesOnOpen(database: ThreaDatabase): void {
  database.on(
    "ready",
    (vip) =>
      // `vip` passes Dexie's open gate, which holds every other transaction until this settles.
      drainPrefetchInbox(vip as ThreaDatabase).catch(async (error: unknown) => {
        console.error("Could not apply the service worker's prefetches; discarding them", error)
        await discardPrefetches(database.name).catch((discardError: unknown) =>
          console.error("Could not discard the service worker's prefetches", discardError)
        )
      }),
    true
  )
}

/** Drains on each worker announcement for `database` and whenever the page becomes visible; returns the unsubscribe. */
export function watchPrefetchInbox(database: ThreaDatabase): () => void {
  let draining = Promise.resolve()
  const drain = () => {
    draining = draining
      .then(() => drainPrefetchInbox(database))
      .catch((error: unknown) =>
        console.error("Could not apply the service worker's prefetches; retrying later", error)
      )
  }
  const onMessage = (event: MessageEvent) => {
    const data = event.data as { type?: unknown; dbName?: unknown } | null
    if (data?.type === SW_MSG_PREFETCH_INBOX && data.dbName === database.name) drain()
  }
  const onVisibility = () => {
    if (document.visibilityState === "visible") drain()
  }
  const worker = navigator.serviceWorker
  worker?.addEventListener("message", onMessage)
  document.addEventListener("visibilitychange", onVisibility)
  return () => {
    worker?.removeEventListener("message", onMessage)
    document.removeEventListener("visibilitychange", onVisibility)
  }
}
