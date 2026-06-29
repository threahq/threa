import type { PoolClient } from "pg"
import { ConversationRepository, type Conversation } from "./repository"
import { StreamRepository } from "../streams"
import { type Message } from "../messaging"
import { OutboxRepository } from "../../lib/outbox"
import { addStalenessFields } from "./staleness"
import { resolveConversationDelivery } from "./conversation-delivery"

/**
 * Emit the conversation aggregate + per-message membership events for a single
 * deterministic assignment (a declared send or an agent reply), mirroring the
 * boundary extractor's persist phase (INV-4/7). This is the one place the
 * declared-send and agent-reply paths share so their event shape can't drift
 * (INV-35/37).
 *
 * Re-reads the conversation so the payload reflects the membership/activity
 * writes that just happened, and resolves a thread's `parentStreamId` so the
 * parent channel's subscribers receive the update too. Returns the refreshed
 * conversation for callers that surface it.
 */
export async function emitAssignmentEvents(
  client: PoolClient,
  params: { workspaceId: string; message: Message; conversationId: string; created: boolean; reason: string }
): Promise<Conversation> {
  const { workspaceId, message, conversationId, created, reason } = params

  const stream = await StreamRepository.findById(client, message.streamId)
  const { parentStreamId, streamVisibility } = await resolveConversationDelivery(client, stream)

  const [refreshed] = await ConversationRepository.findByIds(client, workspaceId, [conversationId])
  if (!refreshed) {
    // The row we just wrote is gone under our own transaction — fail loud (INV-11).
    throw new Error(`Conversation ${conversationId} vanished during assignment`)
  }

  await OutboxRepository.insert(client, created ? "conversation:created" : "conversation:updated", {
    workspaceId,
    streamId: message.streamId,
    conversationId: refreshed.id,
    conversation: addStalenessFields(refreshed),
    parentStreamId,
    streamVisibility,
  })
  await OutboxRepository.insert(client, "conversation:message_assigned", {
    workspaceId,
    streamId: message.streamId,
    parentStreamId,
    messageId: message.id,
    conversationId: refreshed.id,
    isPrimary: true,
    reason,
  })

  return refreshed
}

/**
 * Emit the aggregate update for a conversation that just lost its last message
 * (e.g. a lone source conversation retired when its message was threaded off).
 * Mirrors the reassignment path's emptied-source emit (`service.ts`): the board
 * drops a now-empty conversation (its `cardinality > 0` filter on the server,
 * the delete-on-empty merge on the client), so this is the signal that retires
 * the card. Routed by the conversation's OWN stream (INV-62) — `streamId` here
 * is the source's parent stream, not the thread the reply landed in.
 */
export async function emitConversationRetired(
  client: PoolClient,
  params: { workspaceId: string; conversationId: string; streamId: string }
): Promise<void> {
  const { workspaceId, conversationId, streamId } = params
  const stream = await StreamRepository.findById(client, streamId)
  const { parentStreamId, streamVisibility } = await resolveConversationDelivery(client, stream)
  const [refreshed] = await ConversationRepository.findByIds(client, workspaceId, [conversationId])
  if (!refreshed) {
    // The row we just locked + emptied in this same transaction is gone — an
    // invariant break (INV-11). Throwing rolls back the whole send rather than
    // silently dropping the board-removal event and leaving a stale source card.
    throw new Error(`Conversation ${conversationId} vanished during retirement`)
  }
  await OutboxRepository.insert(client, "conversation:updated", {
    workspaceId,
    streamId,
    conversationId,
    conversation: addStalenessFields(refreshed),
    parentStreamId,
    streamVisibility,
  })
}
