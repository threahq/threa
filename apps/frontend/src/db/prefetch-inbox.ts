import type { StreamEvent } from "@threahq/types"
import type { SlotCarrier } from "@/lib/slots"
import { transactionDone } from "./sqlite-mirror/idb-reads"

/**
 * What the service worker fetched to warm one account's database, as the
 * server sent it: an intent the app applies against the rows it holds then,
 * never a row image.
 */
export type PrefetchPayload =
  | {
      kind: "streamBootstrap"
      workspaceId: string
      streamId: string
      fetchedAt: number
      bootstrap: SlotCarrier & { events: StreamEvent[]; stream?: { id: string } | null; syncMode?: string }
    }
  | {
      kind: "eventsAround"
      workspaceId: string
      streamId: string
      fetchedAt: number
      around: SlotCarrier & { events: StreamEvent[] }
    }

/** Its own database and version, so queueing a prefetch never opens, let alone upgrades, an account database. */
const INBOX_DATABASE = "threa-sw-inbox"
const ENTRIES_STORE = "entries"
const BY_DATABASE_INDEX = "dbName"

/**
 * Per account database, after coalescing to one entry per stream and kind. A
 * push queues at most two, so this holds twenty streams' warm-up for an app
 * nobody opens; older ones only precede the boot's own sync.
 */
export const PREFETCH_INBOX_MAX_ENTRIES = 40

/** Past it a prefetch is dropped unapplied: the boot's own sync is fresher, and nothing tapped it in time. */
export const PREFETCH_INBOX_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000

interface InboxRow {
  dbName: string
  payload: PrefetchPayload
}

export interface InboxEntry {
  key: number
  payload: PrefetchPayload
}

/** One tab drains a database's inbox at a time, so no entry lands after a later one. */
export function prefetchInboxLockName(dbName: string): string {
  return `${INBOX_DATABASE}:${dbName}`
}

function openInbox(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(INBOX_DATABASE, 1)
    request.onupgradeneeded = () =>
      request.result.createObjectStore(ENTRIES_STORE, { autoIncrement: true }).createIndex(BY_DATABASE_INDEX, "dbName")
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function withInbox<T>(mode: IDBTransactionMode, run: (entries: IDBObjectStore) => () => T): Promise<T> {
  const inbox = await openInbox()
  try {
    const tx = inbox.transaction(ENTRIES_STORE, mode, { durability: "strict" })
    const result = run(tx.objectStore(ENTRIES_STORE))
    await transactionDone(tx)
    return result()
  } finally {
    inbox.close()
  }
}

const nothing = () => undefined

/**
 * Queues after every earlier prefetch for `dbName`. It supersedes the queued
 * one of its stream and kind, and past {@link PREFETCH_INBOX_MAX_ENTRIES} the
 * oldest go: a prefetch is a warm-up, so dropping one loses nothing local.
 */
export function appendPrefetch(dbName: string, payload: PrefetchPayload): Promise<void> {
  return withInbox("readwrite", (entries) => {
    const kept: IDBValidKey[] = []
    const queued = entries.index(BY_DATABASE_INDEX).openCursor(dbName)
    queued.onsuccess = () => {
      const cursor = queued.result
      if (cursor) {
        const { kind, streamId } = (cursor.value as InboxRow).payload
        if (kind === payload.kind && streamId === payload.streamId) cursor.delete()
        else kept.push(cursor.primaryKey)
        cursor.continue()
        return
      }
      for (const key of kept.slice(0, Math.max(0, kept.length - PREFETCH_INBOX_MAX_ENTRIES + 1))) entries.delete(key)
      entries.add({ dbName, payload } satisfies InboxRow)
    }
    return nothing
  })
}

/** Every prefetch queued for `dbName`, oldest first. */
export function queuedPrefetches(dbName: string): Promise<InboxEntry[]> {
  return withInbox("readonly", (entries) => {
    const index = entries.index(BY_DATABASE_INDEX)
    const keys = index.getAllKeys(dbName)
    const rows = index.getAll(dbName)
    return () => (rows.result as InboxRow[]).map((row, i) => ({ key: keys.result[i] as number, payload: row.payload }))
  })
}

export function deletePrefetches(keys: readonly number[]): Promise<void> {
  if (keys.length === 0) return Promise.resolve()
  return withInbox("readwrite", (entries) => {
    for (const key of keys) entries.delete(key)
    return nothing
  })
}

/** Drops every prefetch queued for `dbName`. */
export function discardPrefetches(dbName: string): Promise<void> {
  return withInbox("readwrite", (entries) => {
    const queued = entries.index(BY_DATABASE_INDEX).openKeyCursor(dbName)
    queued.onsuccess = () => {
      const cursor = queued.result
      if (!cursor) return
      entries.delete(cursor.primaryKey)
      cursor.continue()
    }
    return nothing
  })
}
