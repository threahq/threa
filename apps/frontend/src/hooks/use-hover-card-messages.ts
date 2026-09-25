import { useMemo } from "react"
import type { StreamEvent } from "@threahq/types"
import type { CachedEvent } from "@/db"
import { useStreamEvents } from "@/stores/stream-store"

const CARD_MESSAGE_LIMIT = 8

export interface HoverCardMessage {
  messageId: string
  sequence: bigint
  /** The `message_created` row; edits and reactions are patched onto its payload as they sync. */
  event: StreamEvent
}

function isCardMessage(row: CachedEvent): boolean {
  if (row.eventType !== "message_created" || row._status === "pending" || row._status === "failed") return false
  const payload = row.payload as { messageId?: string; deletedAt?: string | null } | null
  return !!payload?.messageId && !payload.deletedAt
}

/**
 * A stream's latest messages, read through the timeline's own `useStreamEvents`:
 * the socket keeps the rows current and the sync engine warms the history before a
 * card opens, so reading never fetches. `undefined` until the first read resolves.
 */
export function useHoverCardMessages(streamId: string): HoverCardMessage[] | undefined {
  const events = useStreamEvents(streamId)
  return useMemo(() => {
    if (!events) return undefined
    return events
      .filter(isCardMessage)
      .slice(-CARD_MESSAGE_LIMIT)
      .map((row) => ({
        messageId: (row.payload as { messageId: string }).messageId,
        sequence: BigInt(row.sequence),
        event: row as StreamEvent,
      }))
  }, [events])
}
