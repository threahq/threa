import type { EntityTable } from "dexie"
import type { CachedEvent } from "@/db/database"

/**
 * Dexie 4.4.2 registers precise changed keys for a `bulkPut` of fewer than 50
 * values; at 50 or more it marks FULL_RANGE on the primary key AND on every
 * index of the table (`dexie.js:5199-5226`), which wakes every live query
 * mounted on `db.events` app-wide.
 */
export const EVENT_BULK_PUT_LIMIT = 49

type EventTable = EntityTable<CachedEvent, "id">

/**
 * Writes events in slices below Dexie's FULL_RANGE threshold. Opens no
 * transaction of its own — the caller's transaction is what makes the slices
 * atomic.
 */
export async function putEventsBounded(table: EventTable, rows: CachedEvent[]): Promise<void> {
  if (rows.length === 0) return
  if (rows.length <= EVENT_BULK_PUT_LIMIT) {
    await table.bulkPut(rows)
    return
  }
  for (let start = 0; start < rows.length; start += EVENT_BULK_PUT_LIMIT) {
    await table.bulkPut(rows.slice(start, start + EVENT_BULK_PUT_LIMIT))
  }
}

/**
 * Whether putting `candidate` over `existing` would change nothing the app
 * can observe. Skipping these puts matters for perceived performance: every
 * write to `db.events` re-runs the timeline's `useLiveQuery`, and a bootstrap
 * that rewrites byte-identical rows forces a full-window re-render for no
 * user-visible change. `_cachedAt` is bookkeeping (nothing reads it for
 * eviction or rendering), so a row that differs only by `_cachedAt` is a
 * no-op. Rows carrying optimistic `_status` are never skipped — the put
 * intentionally clears that flag on confirm.
 */
export function isNoOpRewrite(existing: CachedEvent, candidate: CachedEvent): boolean {
  if (existing._status !== undefined) return false
  return (
    existing.streamId === candidate.streamId &&
    existing.workspaceId === candidate.workspaceId &&
    existing.sequence === candidate.sequence &&
    existing.broadcastSequence === candidate.broadcastSequence &&
    existing._clientId === candidate._clientId &&
    existing._sequenceNum === candidate._sequenceNum &&
    existing.eventType === candidate.eventType &&
    existing.actorId === candidate.actorId &&
    existing.actorType === candidate.actorType &&
    existing.createdAt === candidate.createdAt &&
    JSON.stringify(existing.payload) === JSON.stringify(candidate.payload)
  )
}

/** `candidates` minus the rows whose put would change nothing (see {@link isNoOpRewrite}). */
export function skipNoOpEventRewrites(
  existingById: Map<string, CachedEvent>,
  candidates: CachedEvent[]
): CachedEvent[] {
  return candidates.filter((candidate) => {
    const existing = existingById.get(candidate.id)
    return existing === undefined || !isNoOpRewrite(existing, candidate)
  })
}

let accountGeneration = 0

/**
 * Bumped on every account switch (the `flushModuleStoreCaches` site), so a
 * deferred writer that captured the generation can tell that the global `db`
 * proxy was repointed under it and refuse to write account A's rows into
 * account B's database.
 */
export function bumpAccountGeneration(): void {
  accountGeneration += 1
}

/** The current account generation — capture it before deferring a write. */
export function getAccountGeneration(): number {
  return accountGeneration
}
