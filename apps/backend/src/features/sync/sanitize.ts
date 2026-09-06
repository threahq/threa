import type { Querier } from "../../db"
import {
  parseSharedMessageSlotKey,
  sharedMessageSlotKey,
  type MemoEmbedSummary,
  type SharedMessageRef,
} from "@threahq/types"
import { hydrateSharedMessageRefs, type HydratedSharedMessage } from "../messaging"
import { resolveMemoSummariesByStream } from "../memos"
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
 * Slots re-hydrate per VIEWER (`hydrateSharedMessageRefs`) — catch-up is a
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
  const shareRefs = new Map<string, SharedMessageRef>()
  const memoSites: Array<{ holder: MemoEmbedHolder; streamId: string }> = []
  const memoUpdatedEntries: Array<{ entry: SyncLogEntry; streamId: string; memoId: string }> = []

  // The stored KEY carries the pin (`shared:<id>@<v>:<from>-<to>`); the legacy
  // bare-id map does not, so those re-resolve unpinned exactly as they were
  // served. Re-hydrating a pinned slot at the current revision would silently
  // un-pin it on catch-up.
  const refForSlot = (slotKey: string, slot: HydratedSharedMessage): SharedMessageRef =>
    parseSharedMessageSlotKey(slotKey) ?? { messageId: slot.messageId, version: null, range: null }

  const collectSlotMaps = (holder: Record<string, unknown>) => {
    for (const key of ["slots", "sharedMessages"] as const) {
      const map = holder[key] as Record<string, HydratedSharedMessage> | undefined
      if (!map) continue
      for (const [slotKey, slot] of Object.entries(map)) {
        if (!slot || typeof slot.messageId !== "string") continue
        const ref = refForSlot(slotKey, slot)
        shareRefs.set(sharedMessageSlotKey(ref.messageId, ref.version, ref.range), ref)
      }
      if (Object.keys(map).length > 0) slotHolders.push(holder as SlotMapHolder)
    }
  }
  const collectMemoEmbeds = (holder: Record<string, unknown> | undefined, streamId: unknown) => {
    if (!holder || typeof streamId !== "string") return
    // Empty arrays carry nothing to leak or refresh — skipping them keeps a
    // page of plain edits (whose payloads always carry `memoEmbeds: []`) on
    // the zero-query path.
    const embeds = (holder as MemoEmbedHolder).memoEmbeds
    if (Array.isArray(embeds) && embeds.length > 0) {
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

  // Slots: one viewer-scoped hydration for the union of references; every
  // stored map entry is REPLACED — a source the viewer may no longer read
  // comes back as its `private` variant, exactly as a live delivery would.
  if (shareRefs.size > 0) {
    const rehydrated = await hydrateSharedMessageRefs(db, workspaceId, userId, shareRefs.values())
    for (const holder of slotHolders) {
      for (const key of ["slots", "sharedMessages"] as const) {
        const map = holder[key] as Record<string, HydratedSharedMessage> | undefined
        if (!map) continue
        for (const [slotKey, slot] of Object.entries(map)) {
          if (!slot || typeof slot.messageId !== "string") continue
          const ref = refForSlot(slotKey, slot)
          const fresh = rehydrated[sharedMessageSlotKey(ref.messageId, ref.version, ref.range)]
          if (fresh) map[slotKey] = fresh
        }
      }
    }
  }

  // Memo summaries: the shared per-citing-stream resolver (INV-35) groups by
  // root and runs one predicate query per distinct root.
  const dropped = new Set<SyncLogEntry>()
  const memoIdsByStreamId = new Map<string, Set<string>>()
  const addMemoIds = (streamId: string, ids: string[]) => {
    const set = memoIdsByStreamId.get(streamId) ?? new Set<string>()
    for (const id of ids) set.add(id)
    memoIdsByStreamId.set(streamId, set)
  }
  for (const site of memoSites)
    addMemoIds(
      site.streamId,
      (site.holder.memoEmbeds ?? []).map((s) => s.memoId)
    )
  for (const site of memoUpdatedEntries) addMemoIds(site.streamId, [site.memoId])

  if (memoIdsByStreamId.size > 0) {
    const summariesByStream = await resolveMemoSummariesByStream(db, workspaceId, memoIdsByStreamId)

    for (const site of memoSites) {
      const summaries = summariesByStream.get(site.streamId)
      site.holder.memoEmbeds = (site.holder.memoEmbeds ?? [])
        .map((s) => summaries?.get(s.memoId))
        .filter((s): s is MemoEmbedSummary => s !== undefined)
    }
    for (const site of memoUpdatedEntries) {
      const fresh = summariesByStream.get(site.streamId)?.get(site.memoId)
      if (!fresh) {
        dropped.add(site.entry)
      } else {
        ;(site.entry.payload as Record<string, unknown>).summary = fresh
      }
    }
  }

  return dropped.size > 0 ? entries.filter((e) => !dropped.has(e)) : entries
}
