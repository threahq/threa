import { db } from "@/db"

const PERSIST_DEBOUNCE_MS = 1_000

export function syncLogCursorKey(workspaceId: string): string {
  return `${workspaceId}:sync-log`
}

export async function acknowledgeSnapshotCursorInCurrentTransaction(
  workspaceId: string,
  syncId: string
): Promise<string> {
  const key = syncLogCursorKey(workspaceId)
  const candidate = parseSyncId(syncId, "snapshot")
  if (candidate === null) throw new Error("Snapshot returned an invalid sync head")
  const existing = await db.syncCursors.get(key)
  const persisted = existing ? parseSyncId(existing.cursor, "snapshot-existing") : null
  const acknowledged = persisted !== null && persisted > candidate ? persisted : candidate
  if (persisted === null || acknowledged > persisted) {
    await db.syncCursors.put({ key, cursor: acknowledged.toString(), updatedAt: Date.now() })
  }
  return acknowledged.toString()
}

/**
 * Parses a sync id off the wire or out of IDB. Malformed input (a rogue
 * payload, a corrupted row) is ignored loudly instead of throwing — a throw
 * here would crash the hot onAny listener or poison the cursor load.
 */
function parseSyncId(value: string, context: string): bigint | null {
  try {
    return BigInt(value)
  } catch {
    console.warn(`Sync: ignoring malformed sync id (${context})`, { value })
    return null
  }
}

/**
 * The client's single sync-log position for one workspace (`lastSyncId`),
 * persisted in the `syncCursors` IDB table.
 *
 * Advancement is a monotonic BigInt max: live events and catch-up pages can
 * race in any order (sweep-rescued events arrive late, two tabs sync
 * concurrently) and still converge. Persistence is debounced — live events
 * advance the cursor on every message — and the write itself is a
 * read-max-write inside one IDB transaction so concurrent tabs never move
 * the persisted cursor backwards.
 *
 * `dispose()` cancels any pending write WITHOUT flushing: the engine is
 * destroyed on account switch, which repoints the shared `db` proxy, and a
 * cursor is per-user state (the server filters the log per user) that must
 * never leak into another account's database. Losing the last debounce
 * window is harmless — entries are re-fetched and applied idempotently.
 */
export class SyncLogCursor {
  private readonly key: string
  private value: bigint | null = null
  private loadPromise: Promise<void> | null = null
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(
    workspaceId: string,
    private readonly debounceMs: number = PERSIST_DEBOUNCE_MS
  ) {
    this.key = syncLogCursorKey(workspaceId)
  }

  /** Loads the persisted cursor once; concurrent callers share the load. */
  load(): Promise<void> {
    this.loadPromise ??= (async () => {
      const row = await db.syncCursors.get(this.key)
      if (row) {
        const persisted = parseSyncId(row.cursor, "load")
        if (persisted !== null && (this.value === null || persisted > this.value)) {
          this.value = persisted
        }
      }
    })()
    return this.loadPromise
  }

  /** Current cursor, or null when nothing is known yet. Call `load()` first. */
  get(): string | null {
    return this.value?.toString() ?? null
  }

  /** Monotonic max advance; schedules a debounced persist. */
  advance(syncId: string): void {
    if (this.disposed) return
    const candidate = parseSyncId(syncId, "advance")
    if (candidate === null) return
    if (this.value !== null && candidate <= this.value) return
    this.value = candidate
    this.persistTimer ??= setTimeout(() => {
      this.persistTimer = null
      void this.persist()
    }, this.debounceMs)
  }

  acknowledgeDurable(syncId: string): void {
    if (this.disposed) return
    const candidate = parseSyncId(syncId, "durable-acknowledgement")
    if (candidate !== null && (this.value === null || candidate > this.value)) this.value = candidate
  }

  /** Persists any pending advance immediately. */
  async flush(): Promise<void> {
    if (this.disposed) return
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    await this.persist()
  }

  dispose(): void {
    this.disposed = true
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
  }

  private async persist(): Promise<void> {
    if (this.disposed || this.value === null) return
    const value = this.value
    await db.transaction("rw", db.syncCursors, async () => {
      const existing = await db.syncCursors.get(this.key)
      if (existing && BigInt(existing.cursor) >= value) return
      await db.syncCursors.put({ key: this.key, cursor: value.toString(), updatedAt: Date.now() })
    })
  }
}
