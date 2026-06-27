import type { PoolClient } from "pg"
import { StreamTypes } from "@threa/types"
import { ConversationRepository, type Conversation } from "./repository"
import { StreamRepository } from "../streams"
import { MessageRepository, type Message } from "../messaging"
import { OutboxRepository } from "../../lib/outbox"
import { addStalenessFields } from "./staleness"

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

  // Resolve the access-root stream's visibility (INV-62): for a thread that's the
  // parent channel, otherwise the stream itself. It gates workspace-wide board
  // delivery — public conversations reach the whole workspace, others stay
  // scoped to the stream's members.
  let parentStreamId: string | undefined
  const stream = await StreamRepository.findById(client, message.streamId)
  let rootStream = stream
  if (stream?.type === StreamTypes.THREAD && stream.parentMessageId) {
    const parentMessage = await MessageRepository.findById(client, stream.parentMessageId)
    parentStreamId = parentMessage?.streamId
    rootStream = parentMessage ? await StreamRepository.findById(client, parentMessage.streamId) : stream
  }
  const streamVisibility = rootStream?.visibility

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
