import type { PoolClient } from "pg"
import { ConversationRepository } from "./repository"
import { MessageConversationStateRepository, type SettledByReason, type SettlingRow } from "./settling-repository"
import { StreamRepository } from "../streams"
import { OutboxRepository } from "../../lib/outbox"
import { addStalenessFields } from "./staleness"
import { resolveConversationDelivery } from "./conversation-delivery"

/**
 * A human engaged with a provisionally-placed message (reacted to it, saved it),
 * which is the signal that the placement is now theirs to live with: settle it
 * and re-broadcast the affected conversations so every board card drops the
 * message from its settling set. Flip + events commit in the caller's
 * transaction (INV-4/7), so callers pass the transaction client.
 *
 * No-op when none of the messages were settling — the common case.
 */
export async function settleMessagesOnEngagement(
  client: PoolClient,
  workspaceId: string,
  messageIds: string[],
  settledBy: SettledByReason = "engagement"
): Promise<void> {
  const settled = await MessageConversationStateRepository.settle(client, workspaceId, messageIds, settledBy)
  await emitSettledConversationUpdates(client, workspaceId, settled)
}

/**
 * Re-broadcast every conversation whose settling set just changed, so boards
 * drop the settled messages without waiting for an unrelated refetch. Every
 * settle path that isn't already emitting `conversation:updated` must call this
 * in its own transaction (INV-4/7).
 */
export async function emitSettledConversationUpdates(
  client: PoolClient,
  workspaceId: string,
  settled: SettlingRow[]
): Promise<void> {
  if (settled.length === 0) return

  const conversationIds = [...new Set(settled.map((row) => row.conversationId))]
  const conversations = await ConversationRepository.findByIds(client, workspaceId, conversationIds)
  if (conversations.length === 0) return

  const settlingByConversation = await MessageConversationStateRepository.listSettlingByConversationIds(
    client,
    workspaceId,
    conversationIds
  )

  const deliveryByStreamId = new Map<string, Awaited<ReturnType<typeof resolveConversationDelivery>>>()
  const events = []
  for (const conversation of conversations) {
    let delivery = deliveryByStreamId.get(conversation.streamId)
    if (!delivery) {
      delivery = await resolveConversationDelivery(
        client,
        await StreamRepository.findById(client, conversation.streamId)
      )
      deliveryByStreamId.set(conversation.streamId, delivery)
    }
    events.push({
      eventType: "conversation:updated" as const,
      payload: {
        workspaceId,
        streamId: conversation.streamId,
        conversationId: conversation.id,
        conversation: addStalenessFields(conversation),
        parentStreamId: delivery.parentStreamId,
        streamVisibility: delivery.streamVisibility,
        settlingMessageIds: settlingByConversation.get(conversation.id) ?? [],
      },
    })
  }
  await OutboxRepository.insertMany(client, events)
}
