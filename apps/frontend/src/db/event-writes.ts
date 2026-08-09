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

// The `workspaceMetadata` row carries the workspace emoji list — hundreds of KB
// that Dexie must deserialize per read — so resolving the flag from it on every
// event write costs more than the write. Resolve once per workspace per module
// instance instead, primed from the network bootstrap and socket flag flips.
type EventWriteFlags = {
  sharedStreamRegistration: boolean
  singlePreviewWriter: boolean
  coalescedLiveCommit: boolean
}

const flagsByWorkspace = new Map<string, EventWriteFlags>()
let primeGeneration = 0
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

function resolveEventWriteFlags(layers: FeatureFlagLayers | null | undefined): EventWriteFlags {
  const resolved = resolveFeatureFlags(coerceLayers(layers ?? null) ?? EMPTY_FLAG_LAYERS)
  return {
    sharedStreamRegistration: resolved.sharedStreamRegistration === "on",
    singlePreviewWriter: resolved.singlePreviewWriter === "on",
    coalescedLiveCommit: resolved.coalescedLiveCommit === "on",
  }
}

/** Seed the cache from freshly delivered layers (bootstrap response or flag-flip socket event). */
export function primeEventWriteFlags(workspaceId: string, layers: FeatureFlagLayers | null | undefined): void {
  primeGeneration += 1
  flagsByWorkspace.set(workspaceId, resolveEventWriteFlags(layers))
}

/**
 * Seed the cache from the persisted workspace row on a warm start, where
 * registration can run before any network prime. If-absent, not prime: the
 * persisted row is only a warm-start fallback and must never overwrite a
 * network prime that landed while the IDB reads were in flight (same freshness
 * rule as {@link getEventWriteFlags}).
 */
export function primeEventWriteFlagsIfAbsent(workspaceId: string, layers: FeatureFlagLayers | null | undefined): void {
  if (flagsByWorkspace.has(workspaceId)) return
  primeGeneration += 1
  flagsByWorkspace.set(workspaceId, resolveEventWriteFlags(layers))
}

/** Test-only: drop the cache so each case resolves from its own prime/IDB row. */
export function resetEventWriteFlags(): void {
  primeGeneration += 1
  flagsByWorkspace.clear()
}

async function getEventWriteFlags(database: ThreaDatabase, workspaceId: string): Promise<EventWriteFlags> {
  const cached = flagsByWorkspace.get(workspaceId)
  if (cached !== undefined) return cached
  // The persisted row is the warm-start fallback, so a prime that lands while
  // this read is in flight is strictly newer and must win (INV-20).
  const generation = primeGeneration
  const metadata = await database.workspaceMetadata.get(workspaceId)
  const flags = resolveEventWriteFlags(metadata?.featureFlags)
  if (primeGeneration !== generation) return flagsByWorkspace.get(workspaceId) ?? flags
  flagsByWorkspace.set(workspaceId, flags)
  return flags
}

/** The viewer's `singlePreviewWriter` value, resolved through the same primed cache. */
export async function isSinglePreviewWriterEnabled(database: ThreaDatabase, workspaceId: string): Promise<boolean> {
  return (await getEventWriteFlags(database, workspaceId)).singlePreviewWriter
}

/**
 * The viewer's `coalescedLiveCommit` value, read only from the primed map so the
 * synchronous commit seams can re-read it per event. A backoffice flip re-primes
 * the map, so arming and disarming both take effect on the next event; an
 * unprimed read takes the immediate path rather than guessing.
 */
export function isCoalescedLiveCommitEnabledSync(workspaceId: string): boolean {
  return flagsByWorkspace.get(workspaceId)?.coalescedLiveCommit ?? false
}

/**
 * The viewer's `sharedStreamRegistration` value, read only from the primed map.
 * Handler registration is synchronous, so there is no await in which to resolve
 * the persisted row: an unprimed read falls back to the unshared path rather
 * than guessing. A miss costs the optimization for that registration, never
 * correctness — two unshared registrations behave exactly as they do today.
 */
export function isSharedStreamRegistrationEnabledSync(workspaceId: string): boolean {
  return flagsByWorkspace.get(workspaceId)?.sharedStreamRegistration ?? false
}
