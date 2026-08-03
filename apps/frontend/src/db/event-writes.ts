import { coerceLayers, resolveFeatureFlags, type FeatureFlagLayers } from "@threa/types"
import type { EntityTable } from "dexie"
import type { CachedEvent, ThreaDatabase } from "@/db/database"

/**
 * Dexie 4.4.2 registers precise changed keys for a `bulkPut` of fewer than 50
 * values; at 50 or more it marks FULL_RANGE on the primary key AND on every
 * index of the table (`dexie.js:5199-5226`), which wakes every live query
 * mounted on `db.events` app-wide.
 */
export const EVENT_BULK_PUT_LIMIT = 49

type EventTable = EntityTable<CachedEvent, "id">

const EMPTY_FLAG_LAYERS: FeatureFlagLayers = { workspace: {}, user: {} }

/**
 * Writes events in slices below Dexie's FULL_RANGE threshold when `chunked`,
 * and as today's single `bulkPut` when not. Opens no transaction of its own —
 * the caller's transaction is what makes the slices atomic.
 */
export async function putEventsBounded(table: EventTable, rows: CachedEvent[], chunked: boolean): Promise<void> {
  if (rows.length === 0) return
  if (!chunked || rows.length <= EVENT_BULK_PUT_LIMIT) {
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

// The `workspaceMetadata` row carries the workspace emoji list — hundreds of KB
// that Dexie must deserialize per read — so resolving the flag from it on every
// event write costs more than the write. Resolve once per workspace per module
// instance instead, primed from the network bootstrap and socket flag flips.
const chunkingByWorkspace = new Map<string, boolean>()

function resolveChunking(layers: FeatureFlagLayers | null | undefined): boolean {
  return resolveFeatureFlags(coerceLayers(layers ?? null) ?? EMPTY_FLAG_LAYERS).eventWriteChunking === "on"
}

/** Seed the cache from freshly delivered layers (bootstrap response or flag-flip socket event). */
export function primeEventWriteChunking(workspaceId: string, layers: FeatureFlagLayers | null | undefined): void {
  chunkingByWorkspace.set(workspaceId, resolveChunking(layers))
}

/** Test-only: drop the cache so each case resolves from its own prime/IDB row. */
export function resetEventWriteChunking(): void {
  chunkingByWorkspace.clear()
}

/**
 * The viewer's `eventWriteChunking` value — the primed value when one exists,
 * otherwise resolved once from the layers persisted for a warm start. Tolerates
 * the pre-#1455 flat `featureFlags` shape rather than throwing on it.
 */
export async function isEventWriteChunkingEnabled(database: ThreaDatabase, workspaceId: string): Promise<boolean> {
  const cached = chunkingByWorkspace.get(workspaceId)
  if (cached !== undefined) return cached
  const metadata = await database.workspaceMetadata.get(workspaceId)
  const chunked = resolveChunking(metadata?.featureFlags)
  chunkingByWorkspace.set(workspaceId, chunked)
  return chunked
}
