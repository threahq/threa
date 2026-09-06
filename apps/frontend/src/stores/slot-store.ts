import { Dexie } from "dexie"
import type { ThreaDatabase, CachedSlot } from "@/db/database"
import type { Slot, StreamEvent } from "@threahq/types"
import { collectReferencedSlotKeys, normalizeSlotCarrier, type SlotCarrier } from "@/lib/slots"

/**
 * The single slot write boundary (Amendment A2). No slot value reaches IDB
 * except through this module, and normalization happens only here — callers pass
 * the raw wire carrier. Accepts an explicit database target so the main thread
 * (the `db` proxy) and the service-worker prefetch (its own account database)
 * share one implementation; writes participate in whatever Dexie transaction the
 * caller has open on that database.
 */

interface SlotWriteBase {
  database: ThreaDatabase
  workspaceId: string
  /** The stream whose timeline renders these slots. */
  streamId: string
  carrier: SlotCarrier
  cachedAt: number
}

export type SlotWriteParams =
  | (SlotWriteBase & { mode: "merge" })
  | (SlotWriteBase & {
      mode: "replace"
      /**
       * The events of the bootstrap window this carrier is the snapshot of.
       * Replace deletes exactly the slot keys these events reference — keys
       * held by out-of-window pages/jumps/live-tail merges survive (B2), same
       * window-scoping as the bootstrap event prune.
       */
      windowEvents: ReadonlyArray<Pick<StreamEvent, "payload">>
    })

/**
 * B1 richness guard (MERGE mode only). Room-uniform socket carriers can carry
 * `private`/`truncated` for a nested source the viewer's per-viewer bootstrap
 * resolved `ok` (the viewer is a direct member of the nested source's stream).
 * Plain last-writer-wins would collapse rendered content to a placeholder
 * mid-session — a height jump, the regression class this feature kills — and
 * bootstrap is `staleTime: Infinity`, so no in-session refetch heals it.
 * Room-uniform entries carry objective facts (content/edits/deletes) reliably,
 * but viewer-access state is per-viewer: access downgrades flow only through
 * the authoritative per-viewer REPLACE (bootstrap/reconnect, INV-53).
 * `deleted`/`missing` are objective tombstones and always overwrite `ok`;
 * `ok` overwrites `ok` (fresher content). Tombstones are also terminal: a
 * deleted source cannot come back to life and a missing id cannot come into
 * existence, so a stale carrier must never resurrect content past a
 * tombstone — incoming non-tombstone states lose to an existing tombstone.
 */
function preservesRicherExisting(existing: Slot, incoming: Slot): boolean {
  if (existing.state === "deleted" || existing.state === "missing") return incoming.state !== existing.state
  return existing.state === "ok" && (incoming.state === "private" || incoming.state === "truncated")
}

/**
 * Apply a carrier's slots to the store.
 *
 * - A carrier with neither field is a no-op (old-server / map-less tolerance).
 * - `replace`: the carrier is the authoritative snapshot of the bootstrap EVENT
 *   WINDOW — delete the rows for exactly the slot keys the window's events
 *   reference (B2), then write the normalized map. Keys referenced only by
 *   out-of-window pages survive; keys referenced by no current event persist
 *   until stream eviction (A4 cleans). REPLACE is authoritative, so the B1
 *   richness guard does NOT apply — access downgrades converge here.
 * - `merge`: upsert the incoming keys only; other keys survive. Within a stream,
 *   committed writes are last-writer-wins per key, except the B1 guard keeps an
 *   existing `ok` row over an incoming `private`/`truncated` downgrade.
 */
export async function writeSlotCarrier(params: SlotWriteParams): Promise<void> {
  const { database, workspaceId, streamId, carrier, cachedAt } = params
  const normalized = normalizeSlotCarrier(carrier)
  if (normalized === null) return
  const table = database.slots
  const slotKeys = Object.keys(normalized)

  // The merge guard is a read-modify-write and replace is delete-then-put;
  // both must be atomic. Callers with an open transaction (bootstrap apply,
  // socket handlers, page/anchor applies, SW prefetch) already include this
  // table; the two bare call sites (pointer:invalidated, thread-anchor fetch)
  // get their own transaction so the guard can't interleave.
  const apply = async (): Promise<void> => {
    if (params.mode === "replace") {
      const referencedKeys = collectReferencedSlotKeys(params.windowEvents)
      if (referencedKeys.size > 0) {
        await table.bulkDelete([...referencedKeys].map((slotKey) => [streamId, slotKey] as [string, string]))
      }
      if (slotKeys.length === 0) return
      await table.bulkPut(
        slotKeys.map((slotKey) => ({
          workspaceId,
          streamId,
          slotKey,
          value: normalized[slotKey],
          _cachedAt: cachedAt,
        }))
      )
      return
    }

    if (slotKeys.length === 0) return
    // A plain bulkPut can't see existing state, so read the colliding keys
    // first to apply the B1 guard per key.
    const existingRows = await table.bulkGet(slotKeys.map((slotKey) => [streamId, slotKey] as [string, string]))
    const rows: CachedSlot[] = []
    for (let i = 0; i < slotKeys.length; i++) {
      const slotKey = slotKeys[i]
      const value = normalized[slotKey]
      const existing = existingRows[i]
      if (existing && preservesRicherExisting(existing.value, value)) continue
      rows.push({ workspaceId, streamId, slotKey, value, _cachedAt: cachedAt })
    }
    if (rows.length > 0) await table.bulkPut(rows)
  }

  if (Dexie.currentTransaction) return apply()
  return database.transaction("rw", table, apply)
}

/** Drop every slot row for one stream (stream eviction / archive / member removal). */
export async function deleteStreamSlots(database: ThreaDatabase, streamId: string): Promise<void> {
  await database.slots.where("streamId").equals(streamId).delete()
}

/** Drop slot rows for a set of evicted streams in one indexed query. */
export async function deleteSlotsForStreams(database: ThreaDatabase, streamIds: readonly string[]): Promise<void> {
  if (streamIds.length === 0) return
  await database.slots.where("streamId").anyOf(streamIds).delete()
}
