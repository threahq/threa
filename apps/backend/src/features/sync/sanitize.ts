import type { Querier } from "../../db"
import type { MemoEmbedSummary } from "@threa/types"
import { hydrateSharedMessageIds, type HydratedSharedMessage } from "../messaging"
import { MemoRepository } from "../memos"
import { StreamRepository } from "../streams"
import type { SyncLogEntry } from "./repository"

/**
 * Re-resolve access-gated snapshot content in sync-log entries at SERVE time.
 *
 * Sync-log payloads are copied verbatim from the outbox and replayed for up to
 * the retention window. The hydrated shared-message slots and memo-embed
 * summaries inside them are snapshots of a PAST access decision — replaying
 * one after its source went private is a fresh delivery of withheld content,
 * not tolerable staleness (bootstrap already re-resolves; this closes the
 * catch-up path). Entries with none of that content pass through untouched
 * with zero extra queries.
 *
 * Slots re-hydrate per VIEWER (`hydrateSharedMessageIds`) — catch-up is a
 * per-user read, and the viewer-scoped resolver is the sharing feature's own
 * read-path authority. Memo summaries re-resolve per citing ROOT
 * (`findEmbedSummaries`) — cards are room-gated, not viewer-gated. A
 * `memo:updated` entry whose summary the room may no longer see is dropped
 * whole.
 */
export async function sanitizeSyncEntries(
  db: Querier,
  params: { workspaceId: string; userId: string; entries: SyncLogEntry[] }
): Promise<SyncLogEntry[]> {
  const { workspaceId, userId, entries } = params

  type SlotMapHolder = Record<string, unknown> & { slots?: Record<string, HydratedSharedMessage> }
  type MemoEmbedHolder = Record<string, unknown> & { memoEmbeds?: MemoEmbedSummary[] }

  const slotHolders: SlotMapHolder[] = []
  const shareIds = new Set<string>()
  const memoSites: Array<{ holder: MemoEmbedHolder; streamId: string }> = []
  const memoUpdatedEntries: Array<{ entry: SyncLogEntry; streamId: string; memoId: string }> = []

  const collectSlotMaps = (holder: Record<string, unknown>) => {
    for (const key of ["slots", "sharedMessages"] as const) {
      const map = holder[key] as Record<string, HydratedSharedMessage> | undefined
      if (!map) continue
      for (const slot of Object.values(map)) {
        if (slot && typeof slot.messageId === "string") shareIds.add(slot.messageId)
      }
      if (Object.keys(map).length > 0) slotHolders.push(holder as SlotMapHolder)
    }
  }
  const collectMemoEmbeds = (holder: Record<string, unknown> | undefined, streamId: unknown) => {
    if (!holder || typeof streamId !== "string") return
    if (Array.isArray((holder as MemoEmbedHolder).memoEmbeds)) {
      memoSites.push({ holder: holder as MemoEmbedHolder, streamId })
    }
  }

  for (const entry of entries) {
    const p = entry.payload as Record<string, unknown>
    if (!p || typeof p !== "object") continue
    collectSlotMaps(p)
    const wrappedEvent = p.event as { payload?: Record<string, unknown> } | undefined
    collectMemoEmbeds(wrappedEvent?.payload, p.streamId)
    if (entry.eventType === "messages:moved" && Array.isArray(p.events)) {
      for (const moved of p.events as Array<{ eventType?: string; payload?: Record<string, unknown> }>) {
        collectMemoEmbeds(moved?.payload, p.destinationStreamId)
      }
    }
    if (entry.eventType === "memo:updated") {
      const summary = p.summary as MemoEmbedSummary | undefined
      if (summary && typeof p.streamId === "string") {
        memoUpdatedEntries.push({ entry, streamId: p.streamId, memoId: summary.memoId })
      }
    }
  }

  if (slotHolders.length === 0 && memoSites.length === 0 && memoUpdatedEntries.length === 0) {
    return entries
  }

  // Slots: one viewer-scoped hydration for the union of source ids; every
  // stored map entry is REPLACED — a source the viewer may no longer read
  // comes back as its `private` variant, exactly as a live delivery would.
  if (shareIds.size > 0) {
    const rehydrated = await hydrateSharedMessageIds(db, workspaceId, userId, shareIds)
    for (const holder of slotHolders) {
      for (const key of ["slots", "sharedMessages"] as const) {
        const map = holder[key] as Record<string, HydratedSharedMessage> | undefined
        if (!map) continue
        for (const [slotKey, slot] of Object.entries(map)) {
          const fresh = slot && typeof slot.messageId === "string" ? rehydrated[slot.messageId] : undefined
          if (fresh) map[slotKey] = fresh
        }
      }
    }
  }

  // Memo summaries: resolve each citing stream to its root, then one
  // predicate query per distinct root for the union of cited ids.
  const citingStreamIds = [
    ...new Set([...memoSites.map((s) => s.streamId), ...memoUpdatedEntries.map((s) => s.streamId)]),
  ]
  const dropped = new Set<SyncLogEntry>()
  if (citingStreamIds.length > 0) {
    const streams = await StreamRepository.findByIds(db, citingStreamIds)
    const rootByStream = new Map(citingStreamIds.map((id) => [id, id]))
    for (const stream of streams) rootByStream.set(stream.id, stream.rootStreamId ?? stream.id)

    const memoIdsByRoot = new Map<string, Set<string>>()
    const addMemoIds = (streamId: string, ids: string[]) => {
      const root = rootByStream.get(streamId) ?? streamId
      let set = memoIdsByRoot.get(root)
      if (!set) memoIdsByRoot.set(root, (set = new Set()))
      for (const id of ids) set.add(id)
    }
    for (const site of memoSites)
      addMemoIds(
        site.streamId,
        (site.holder.memoEmbeds ?? []).map((s) => s.memoId)
      )
    for (const site of memoUpdatedEntries) addMemoIds(site.streamId, [site.memoId])

    const summariesByRoot = new Map<string, Map<string, MemoEmbedSummary>>()
    for (const [root, ids] of memoIdsByRoot) {
      summariesByRoot.set(root, await MemoRepository.findEmbedSummaries(db, workspaceId, [...ids], root))
    }

    for (const site of memoSites) {
      const root = rootByStream.get(site.streamId) ?? site.streamId
      const summaries = summariesByRoot.get(root)
      site.holder.memoEmbeds = (site.holder.memoEmbeds ?? [])
        .map((s) => summaries?.get(s.memoId))
        .filter((s): s is MemoEmbedSummary => s !== undefined)
    }
    for (const site of memoUpdatedEntries) {
      const root = rootByStream.get(site.streamId) ?? site.streamId
      const fresh = summariesByRoot.get(root)?.get(site.memoId)
      if (!fresh) {
        dropped.add(site.entry)
      } else {
        ;(site.entry.payload as Record<string, unknown>).summary = fresh
      }
    }
  }

  return dropped.size > 0 ? entries.filter((e) => !dropped.has(e)) : entries
}
