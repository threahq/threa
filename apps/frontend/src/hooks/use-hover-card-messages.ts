import { useLiveQuery } from "dexie-react-hooks"
import Dexie from "dexie"
import type { StreamEvent } from "@threahq/types"
import { db, type CachedEvent } from "@/db"

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
 * A stream's latest messages from the local store, live: the socket keeps the rows
 * current and the sync engine warms the history before a card opens, so reading
 * never fetches. `undefined` until the first read resolves.
 */
export function useHoverCardMessages(streamId: string): HoverCardMessage[] | undefined {
  return useLiveQuery(async () => {
    const rows = await db.events
      .where("[streamId+_sequenceNum]")
      .between([streamId, Dexie.minKey], [streamId, Dexie.maxKey], true, true)
      .reverse()
      .filter(isCardMessage)
      .limit(CARD_MESSAGE_LIMIT)
      .toArray()
    return rows
      .sort((a, b) => a._sequenceNum - b._sequenceNum)
      .map((row) => ({
        messageId: (row.payload as { messageId: string }).messageId,
        sequence: BigInt(row.sequence),
        event: row as StreamEvent,
      }))
  }, [streamId])
}
