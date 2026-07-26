import Dexie from "dexie"
import { useLiveQuery } from "dexie-react-hooks"
import { db, type CachedStreamContextItem } from "@/db"
import type { StreamContextItem, StreamContextScope } from "@threa/types"

/** The compound-index carrier for occurrence lookups — see {@link CachedStreamContextItem}. */
export function contextGroupRef(item: Pick<StreamContextItem, "category" | "groupKey">): string {
  return `${item.category}:${item.groupKey}`
}

function toCached(workspaceId: string, rootStreamId: string, item: StreamContextItem): CachedStreamContextItem {
  return {
    ...item,
    workspaceId,
    rootStreamId,
    groupRef: contextGroupRef(item),
    _cachedAt: Date.now(),
  }
}

/**
 * Reactive "In this stream" feed, newest first — the panel's read authority,
 * mirroring how the timeline reads `events` from IDB. A live sync applier or a
 * page seed re-sorts the feed in place without a refetch. Returns `undefined`
 * until the first IDB read resolves (loading), `[]` when genuinely empty.
 *
 * `scope: "tree"` reads the root's whole thread tree (INV-62 — a thread's
 * content belongs to its root's context); `"stream"` reads just this stream.
 */
export function useStreamContextRows(
  workspaceId: string,
  streamId: string,
  rootStreamId: string,
  scope: StreamContextScope
): CachedStreamContextItem[] | undefined {
  return useLiveQuery(async () => {
    const [index, anchor] =
      scope === "tree"
        ? (["[rootStreamId+occurredAt]", rootStreamId] as const)
        : (["[streamId+occurredAt]", streamId] as const)
    const rows = await db.streamContextItems
      .where(index)
      .between([anchor, Dexie.minKey], [anchor, Dexie.maxKey])
      .reverse()
      .toArray()
    // Cross-workspace ids never collide, but the filter keeps a stale row from a
    // previous account's database out of the feed if one is ever left behind.
    return rows.filter((row) => row.workspaceId === workspaceId)
  }, [workspaceId, streamId, rootStreamId, scope])
}

/**
 * Every occurrence of one collapsed group ("shared 4 times"), newest first.
 * Locally derived rows group by their raw `refId` until the server's normalized
 * `groupKey` lands, so an expanded group can gain members on reconcile.
 */
export function useStreamContextOccurrences(groupRef: string | null): CachedStreamContextItem[] | undefined {
  return useLiveQuery(async () => {
    if (!groupRef) return []
    return db.streamContextItems
      .where("[groupRef+occurredAt]")
      .between([groupRef, Dexie.minKey], [groupRef, Dexie.maxKey])
      .reverse()
      .toArray()
  }, [groupRef])
}

/**
 * Seed the store from a fetched page (subscribe-then-fetch, INV-53). `bulkPut`
 * upserts the fetched rows without touching rows the page didn't return, so a
 * locally derived row the server hasn't projected yet survives, and a row the
 * server does return reconciles over its local copy under the same `key` —
 * gaining the real `groupKey`/`detail` and losing `_status`.
 */
export async function seedStreamContextItems(
  workspaceId: string,
  rootStreamId: string,
  items: StreamContextItem[]
): Promise<void> {
  if (items.length === 0) return
  await db.streamContextItems.bulkPut(items.map((item) => toCached(workspaceId, rootStreamId, item)))
}

/**
 * Write locally derived rows (`contextItemsFromEvent`) so the panel shows an
 * artifact the instant its message lands, offline included. Marked
 * `_status: "pending"`: the server row that reconciles them shares the `key`,
 * so there is no insert-then-swap and no duplicate.
 */
export async function putLocalContextRows(rows: CachedStreamContextItem[]): Promise<void> {
  if (rows.length === 0) return
  await db.transaction("rw", db.streamContextItems, async () => {
    // Never downgrade a reconciled row. Event re-delivery is routine (catch-up
    // replays every sync-log entry through these handlers, and the gate's resume
    // splice re-applies buffered live events), so a blind `bulkPut` would stomp
    // the server's `groupKey`/`detail` back to a bare local row on every
    // reconnect. Only absent or still-`pending` keys are written.
    const existing = await db.streamContextItems.bulkGet(rows.map((row) => row.key))
    const reconciled = new Set(existing.filter((row) => row && row._status !== "pending").map((row) => row!.key))
    const writable = rows.filter((row) => !reconciled.has(row.key))
    if (writable.length === 0) return
    await db.streamContextItems.bulkPut(writable.map((row) => ({ ...row, _status: "pending" as const })))
  })
}

/** Drop every row a message contributed — its delete (the server does the same
 *  with `deleteByMessageId`). */
export async function deleteContextRowsForMessage(workspaceId: string, messageId: string): Promise<void> {
  await db.streamContextItems.where("[workspaceId+sourceMessageId]").equals([workspaceId, messageId]).delete()
}

/**
 * Rebuild a message's rows after an edit, preserving what only the server knows.
 *
 * A delete-then-put would drop the reconciled `groupKey`/`detail` of rows the
 * edit did not touch — `putLocalContextRows`' never-downgrade guard cannot see a
 * row that was just deleted, so a typo fix would strip a link's title and
 * regress its collapse key to the raw href. Surviving keys keep their reconciled
 * fields and take only the re-derived ones; keys the edit removed are deleted;
 * genuinely new keys land as pending.
 */
export async function replaceContextRowsForMessage(
  workspaceId: string,
  messageId: string,
  rows: CachedStreamContextItem[]
): Promise<void> {
  await db.transaction("rw", db.streamContextItems, async () => {
    const existing = await db.streamContextItems
      .where("[workspaceId+sourceMessageId]")
      .equals([workspaceId, messageId])
      .toArray()
    const existingByKey = new Map(existing.map((row) => [row.key, row]))
    const nextKeys = new Set(rows.map((row) => row.key))

    const removed = existing.filter((row) => !nextKeys.has(row.key)).map((row) => row.key)
    if (removed.length > 0) await db.streamContextItems.bulkDelete(removed)

    const merged = rows.map((row) => {
      const prior = existingByKey.get(row.key)
      if (!prior || prior._status === "pending") return { ...row, _status: "pending" as const }
      return {
        ...prior,
        snippet: row.snippet,
        occurredAt: row.occurredAt,
        streamId: row.streamId,
        rootStreamId: row.rootStreamId,
        _cachedAt: row._cachedAt,
      }
    })
    await db.streamContextItems.bulkPut(merged)
  })
}

/**
 * Re-home the rows of moved messages onto the thread they now live in. The
 * artifacts keep their identity (`key` is message-scoped, not stream-scoped), so
 * this is a patch, never a delete-and-rebuild — mirrors the server's
 * `reparentMessages`.
 */
export async function reparentContextRows(
  workspaceId: string,
  messageIds: string[],
  streamId: string,
  rootStreamId: string
): Promise<void> {
  if (messageIds.length === 0) return
  await db.streamContextItems
    .where("[workspaceId+sourceMessageId]")
    .anyOf(messageIds.map((messageId) => [workspaceId, messageId]))
    .modify({ streamId, rootStreamId })
}
