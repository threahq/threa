import type { PoolClient } from "pg"
import { ConversationRepository, type Conversation } from "./repository"
import { StreamRepository } from "../streams"
import { type Message } from "../messaging"
import { OutboxRepository } from "../../lib/outbox"
import { addStalenessFields } from "./staleness"
import { MessageConversationStateRepository } from "./settling-repository"
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
  params: {
    workspaceId: string
    message: Message
    conversationId: string
    created: boolean
    reason: string
    settling?: boolean
  }
): Promise<Conversation> {
  const { workspaceId, message, conversationId, created, reason, settling = false } = params

  const stream = await StreamRepository.findById(client, message.streamId)
  const { parentStreamId, streamVisibility } = await resolveConversationDelivery(client, stream)

  const [refreshed] = await ConversationRepository.findByIds(client, workspaceId, [conversationId])
  if (!refreshed) {
    // The row we just wrote is gone under our own transaction — fail loud (INV-11).
    throw new Error(`Conversation ${conversationId} vanished during assignment`)
  }

  // The conversation may hold provisional members beyond this assignment — the
  // payload must carry the full set.
  const settlingByConversation = await MessageConversationStateRepository.listSettlingByConversationIds(
    client,
    workspaceId,
    [refreshed.id]
  )

  await OutboxRepository.insert(client, created ? "conversation:created" : "conversation:updated", {
    workspaceId,
    streamId: message.streamId,
    conversationId: refreshed.id,
    conversation: addStalenessFields(refreshed),
    parentStreamId,
    streamVisibility,
    settlingMessageIds: settlingByConversation.get(refreshed.id) ?? [],
  })
  await OutboxRepository.insert(client, "conversation:message_assigned", {
    workspaceId,
    streamId: message.streamId,
    parentStreamId,
    messageId: message.id,
    conversationId: refreshed.id,
    isPrimary: true,
    reason,
    settling,
  })

  return refreshed
}
