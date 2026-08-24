import { useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { db } from "@/db"
import { useActors } from "@/hooks/use-actors"
import { formatTime } from "@/lib/dates"

export interface AsideAnchor {
  /** Display name of whoever wrote the anchored message. */
  author: string
  /** Send time, device-local (INV-42). */
  at: string
}

/**
 * Who wrote the message an aside was opened from, and when — for the anchor
 * line in the aside header.
 *
 * Local-first, the same tier the in-app link chip uses: the anchor is a message
 * in the stream the viewer is reading beside the aside, so it is already in the
 * timeline cache and resolves with no round-trip. `null` when there is no
 * anchor message or it isn't cached; the caller names the host stream instead
 * of inventing an author (INV-11).
 */
export function useAsideAnchor(
  workspaceId: string,
  hostStreamId: string,
  anchorId?: string | null
): AsideAnchor | null {
  const actors = useActors(workspaceId)
  const anchorEvent = useLiveQuery(
    async () => {
      if (!anchorId) return null
      // The `payload.messageId` index (v47) exists so a message anchor is a
      // direct lookup; the `[streamId+eventType]` range would re-scan every
      // message in the host stream on each new one while the aside is open.
      const events = await db.events.where("payload.messageId").equals(anchorId).toArray()
      return events.find((event) => event.streamId === hostStreamId && event.eventType === "message_created") ?? null
    },
    [anchorId, hostStreamId],
    null
  )

  return useMemo(() => {
    if (!anchorEvent?.actorId) return null
    return {
      author: actors.getActorName(anchorEvent.actorId, anchorEvent.actorType ?? "user"),
      at: formatTime(new Date(anchorEvent.createdAt)),
    }
  }, [anchorEvent, actors])
}
