import type { Querier } from "../../db"
import { OutboxRepository } from "../../lib/outbox"
import { StreamRepository, type MessageCountChange } from "./repository"

/**
 * Row-locks each stream with its ancestor chain and access root in id order,
 * the order principal writes take, so the root's visibility can't change under
 * a count event. Take it before any message row lock: principal deletes lock
 * streams first, and the opposite order deadlocks against them.
 */
export async function lockMessageCountStreams(
  client: Querier,
  workspaceId: string,
  streamIds: readonly string[]
): Promise<void> {
  const chainIds = await StreamRepository.listAncestorChainIds(client, workspaceId, streamIds)
  await StreamRepository.findByIdsForUpdateBlocking(client, workspaceId, chainIds)
}

/**
 * Apply a live-message delta to a stream's all-time count and queue the change
 * in the caller's transaction (INV-4/7). It row-locks the stream chain, so call
 * it before allocating the event sequence: streams before stream_sequences is
 * the order archive and principal writes take. A stream the backfill has not
 * counted yet stays uncounted and publishes nothing.
 */
export async function adjustStreamMessageCount(
  client: Querier,
  workspaceId: string,
  streamId: string,
  delta: number
): Promise<void> {
  await lockMessageCountStreams(client, workspaceId, [streamId])
  const change = await StreamRepository.adjustMessageCount(client, workspaceId, streamId, delta)
  if (change) await publishStreamMessageCount(client, change)
}

export async function publishStreamMessageCount(client: Querier, change: MessageCountChange): Promise<void> {
  await OutboxRepository.insert(client, "stream:message_count", {
    workspaceId: change.workspaceId,
    streamId: change.streamId,
    rootStreamId: change.rootStreamId,
    streamVisibility: change.accessVisibility,
    messageCount: change.messageCount,
    messageCountRevision: change.messageCountRevision,
  })
}
