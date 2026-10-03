import { useLiveQuery } from "dexie-react-hooks"
import { db } from "@/db"
import type { SlotMap } from "@threahq/types"

/**
 * Canonical live read of a stream's slot map (Amendment A3). Backed by
 * `db.slots`; the sync layer is the only writer. Returns `undefined` until the
 * query resolves for the current workspace and `streamId` — the same stamp/guard
 * `useStreamEvents` uses, so a workspace or stream switch can't expose the
 * previous key's map for one render (a stale empty result would otherwise read as "current
 * stream has no slots"). Materializes `{ [slotKey]: value }`; no carrier
 * normalization or legacy vocabulary reaches components.
 */
export function useStreamSlots(workspaceId: string, streamId: string | undefined | null): SlotMap | undefined {
  const result = useLiveQuery(async () => {
    if (!streamId) return null
    const rows = await db.slots.where("[workspaceId+streamId]").equals([workspaceId, streamId]).toArray()
    const map: SlotMap = {}
    for (const row of rows) map[row.slotKey] = row.value
    return { forWorkspaceId: workspaceId, forStreamId: streamId, map }
  }, [workspaceId, streamId])

  if (!streamId) return undefined
  if (!result || result.forWorkspaceId !== workspaceId || result.forStreamId !== streamId) return undefined
  return result.map
}
