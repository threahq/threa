import { getActiveDb, type ThreaDatabase } from "@/db"

/**
 * Allocates an optimistic sequence after the latest locally cached event.
 * Call this inside the same read-write events transaction that persists the event.
 *
 * @param streamId - Stream receiving the optimistic event.
 * @param now - Clock value used as the minimum sequence.
 * @param database - The account's database. Pass the handle the caller captured
 *   for its send: the default resolves the active one, which an account switch
 *   repoints — reading it here would look outside the caller's transaction, at
 *   the replacement account's events.
 * @returns A decimal sequence string unique within the serialized transaction.
 * @example
 * const sequence = await nextOptimisticSequence(streamId)
 */
export async function nextOptimisticSequence(
  streamId: string,
  now = Date.now(),
  database: ThreaDatabase = getActiveDb()
): Promise<string> {
  const latest = await database.events
    .where("[streamId+_sequenceNum]")
    .between([streamId, 0], [streamId, Number.MAX_SAFE_INTEGER], true, true)
    .reverse()
    .first()
  return Math.max(now, (latest?._sequenceNum ?? 0) + 1).toString()
}
