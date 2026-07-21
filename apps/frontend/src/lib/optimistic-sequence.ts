import { db } from "@/db"

export async function nextOptimisticSequence(streamId: string, now = Date.now()): Promise<string> {
  const latest = await db.events
    .where("[streamId+_sequenceNum]")
    .between([streamId, 0], [streamId, Number.MAX_SAFE_INTEGER], true, true)
    .reverse()
    .first()
  return Math.max(now, (latest?._sequenceNum ?? 0) + 1).toString()
}
