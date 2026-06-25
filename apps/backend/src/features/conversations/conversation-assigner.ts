import type { PoolClient } from "pg"
import { ConversationRepository } from "./repository"
import { StreamRepository } from "../streams"
import { MessageRepository, type ConversationAssigner } from "../messaging"
import type { Message } from "../messaging"
import { OutboxRepository } from "../../lib/outbox"
import { addStalenessFields } from "./staleness"
import { conversationId } from "../../lib/id"
import { ConversationIntents, ConversationStatuses } from "@threa/types"
import { HttpError } from "../../lib/errors"
import { StreamTypes } from "@threa/types"

/**
 * Emit the conversation aggregate + per-message membership events for a declared
 * assignment, mirroring the boundary extractor's persist phase (INV-4/7). Thread
 * conversations carry `parentStreamId` so the parent channel's subscribers see
 * the update too.
 */
async function emitAssignment(
  client: PoolClient,
  workspaceId: string,
  message: Message,
  conversationIdValue: string,
  created: boolean
): Promise<void> {
  let parentStreamId: string | undefined
  const stream = await StreamRepository.findById(client, message.streamId)
  if (stream?.type === StreamTypes.THREAD && stream.parentMessageId) {
    const parentMessage = await MessageRepository.findById(client, stream.parentMessageId)
    parentStreamId = parentMessage?.streamId
  }

  const [refreshed] = await ConversationRepository.findByIds(client, workspaceId, [conversationIdValue])
  if (!refreshed) {
    // The row we just wrote is gone under our own transaction — fail loud (INV-11).
    throw new Error(`Declared conversation ${conversationIdValue} vanished during assignment`)
  }

  await OutboxRepository.insert(client, created ? "conversation:created" : "conversation:updated", {
    workspaceId,
    streamId: message.streamId,
    conversationId: refreshed.id,
    conversation: addStalenessFields(refreshed),
    parentStreamId,
  })
  await OutboxRepository.insert(client, "conversation:message_assigned", {
    workspaceId,
    streamId: message.streamId,
    parentStreamId,
    messageId: message.id,
    conversationId: refreshed.id,
    isPrimary: true,
    reason: "declared",
  })
}

/**
 * Assigns a message that DECLARED its conversation at send time, synchronously,
 * in the send's transaction (so the board reflects it the instant the send
 * returns and the async extractor leaves it locked — the message row carries
 * `conversation_intent`). Injected into the messaging `EventService` so messaging
 * stays decoupled from conversation internals.
 *
 *  - `new`: mint a fresh conversation in the message's stream, seeded with it.
 *    An authored post is a new topic boundary even inside a scratchpad, so this
 *    always creates rather than joining the stream's existing conversation.
 *  - `existing`: attach the message to the named conversation, which must live in
 *    the same stream + workspace (conversations are per-stream); a stale/foreign
 *    id is rejected (400) rather than silently mis-assigned.
 */
export const conversationAssigner: ConversationAssigner = {
  async assignInTransaction(client, { workspaceId, message, directive }) {
    if (directive.intent === ConversationIntents.NEW) {
      const newId = conversationId()
      await ConversationRepository.insert(client, {
        id: newId,
        streamId: message.streamId,
        workspaceId,
        confidence: 1,
        status: ConversationStatuses.ACTIVE,
      })
      await ConversationRepository.addPrimaryMessage(client, workspaceId, newId, message.id, message.authorId)
      await ConversationRepository.bumpActivityForIds(client, workspaceId, [newId])
      await emitAssignment(client, workspaceId, message, newId, true)
      return
    }

    const target = await ConversationRepository.findById(client, directive.conversationId)
    if (!target || target.workspaceId !== workspaceId || target.streamId !== message.streamId) {
      throw new HttpError("Conversation not found in this stream", {
        status: 400,
        code: "CONVERSATION_NOT_IN_STREAM",
      })
    }
    await ConversationRepository.addPrimaryMessage(client, workspaceId, target.id, message.id, message.authorId)
    // Attaching a message to a resolved conversation revives it — it has activity again.
    await ConversationRepository.reactivateIfResolved(client, workspaceId, target.id)
    await ConversationRepository.bumpActivityForIds(client, workspaceId, [target.id])
    await emitAssignment(client, workspaceId, message, target.id, false)
  },
}
