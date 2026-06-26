import { ConversationRepository } from "./repository"
import type { ConversationAssigner } from "../messaging"
import { emitAssignmentEvents } from "./assignment-events"
import { conversationId } from "../../lib/id"
import { ConversationIntents, ConversationStatuses } from "@threa/types"
import { HttpError } from "../../lib/errors"

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
      await emitAssignmentEvents(client, {
        workspaceId,
        message,
        conversationId: newId,
        created: true,
        reason: "declared",
      })
      return
    }

    // Workspace-scoped + row-locked (INV-8, INV-20): a stale/foreign id resolves
    // to null (rejected below) and a concurrent resolve/delete serializes behind
    // this attach instead of racing it.
    const target = await ConversationRepository.findByIdForUpdate(client, workspaceId, directive.conversationId)
    if (!target || target.streamId !== message.streamId) {
      throw new HttpError("Conversation not found in this stream", {
        status: 400,
        code: "CONVERSATION_NOT_IN_STREAM",
      })
    }
    await ConversationRepository.addPrimaryMessage(client, workspaceId, target.id, message.id, message.authorId)
    // Attaching a message to a resolved conversation revives it — it has activity again.
    await ConversationRepository.reactivateIfResolved(client, workspaceId, target.id)
    await ConversationRepository.bumpActivityForIds(client, workspaceId, [target.id])
    await emitAssignmentEvents(client, {
      workspaceId,
      message,
      conversationId: target.id,
      created: false,
      reason: "declared",
    })
  },
}
