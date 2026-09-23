import type { Querier } from "../../db"
import { OutboxRepository } from "../../lib/outbox"
import { ReadStateRepository } from "./read-state-repository"

/** Unhold the given streams and tell the user's sessions, on the caller's transaction. Returns the ids that were held. */
export async function releaseInboxHold(
  db: Querier,
  workspaceId: string,
  userId: string,
  streamIds: string[]
): Promise<string[]> {
  const released = await ReadStateRepository.clearInboxHeld(db, workspaceId, userId, streamIds)
  if (released.length > 0) {
    await OutboxRepository.insert(db, "stream:inbox_updated", {
      workspaceId,
      authorId: userId,
      streamIds: released,
      held: false,
    })
  }
  return released
}
