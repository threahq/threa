import { db } from "@/db"

/**
 * Kill switch for the sync-engine v2 cursor shadow path (cursor tracking +
 * shadow catch-up in SyncEngine). Shadow mode observes and logs only — it
 * never applies catch-up entries — so it defaults on; set
 * VITE_SYNC_V2_CURSOR=off to disable.
 */
export const SYNC_V2_CURSOR_SHADOW_DEFAULT = import.meta.env.VITE_SYNC_V2_CURSOR !== "off"

const PERSIST_DEBOUNCE_MS = 1_000

export function syncLogCursorKey(workspaceId: string): string {
  return `${workspaceId}:sync-log`
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
        const persisted = BigInt(row.cursor)
        if (this.value === null || persisted > this.value) {
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
    const candidate = BigInt(syncId)
    if (this.value !== null && candidate <= this.value) return
    this.value = candidate
    this.persistTimer ??= setTimeout(() => {
      this.persistTimer = null
      void this.persist()
    }, this.debounceMs)
  }

  /** Persists any pending advance immediately. */
  async flush(): Promise<void> {
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
