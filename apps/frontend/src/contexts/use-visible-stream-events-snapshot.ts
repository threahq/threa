import { useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { loadStreamEvents } from "@/stores/stream-store"

export interface VisibleStreamEventsSnapshot {
  key: string
  eventCounts: Record<string, number>
}

function makeVisibleStreamEventsKey(workspaceId: string, streamIds: string[]): string {
  return `${workspaceId}\u0000${streamIds.join("\u0000")}`
}

export function useVisibleStreamEventsSnapshot(
  workspaceId: string,
  streamIds: string[]
): VisibleStreamEventsSnapshot | undefined {
  const snapshotKey = useMemo(() => makeVisibleStreamEventsKey(workspaceId, streamIds), [workspaceId, streamIds])
  const initialValue = useMemo<VisibleStreamEventsSnapshot | undefined>(
    () => (streamIds.length === 0 ? { key: snapshotKey, eventCounts: {} } : undefined),
    [snapshotKey, streamIds.length]
  )

  const snapshot = useLiveQuery(
    async () => {
      const entries = await Promise.all(
        streamIds.map(async (streamId) => {
          const events = await loadStreamEvents(streamId, null)
          return [streamId, events.length] as const
        })
      )

      return { key: snapshotKey, eventCounts: Object.fromEntries(entries) }
    },
    [snapshotKey],
    initialValue
  )

  return snapshot?.key === snapshotKey ? snapshot : undefined
}
