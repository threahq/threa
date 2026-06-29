import { ConversationRepository } from "./repository"
import type { ConversationAssigner } from "../messaging"
import { emitAssignmentEvents, emitConversationRetired } from "./assignment-events"
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
 *  - `threadFromMessage`: mint the thread's conversation seeded with this reply
 *    (the thread's first message), then retire the lone `sourceConversationId`
 *    it threaded off — its only message is now the thread's parent (in the parent
 *    stream, referenced not moved), so emptying it drops the duplicate board
 *    card, leaving just the thread. Retirement is idempotent (a retried send
 *    must not 400) and defensive: a non-lone/foreign source is left intact.
 */
export const conversationAssigner: ConversationAssigner = {
  async assignInTransaction(client, { workspaceId, message, directive }) {
    if (directive.intent === ConversationIntents.NEW || directive.intent === ConversationIntents.THREAD_FROM_MESSAGE) {
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

      if (directive.intent === ConversationIntents.THREAD_FROM_MESSAGE) {
        // Retire the source. Lock + workspace-scope (INV-8/20); only empty a
        // source that is still lone and lives in a DIFFERENT stream than this
        // reply (the parent stream, not the thread) — a non-lone source is a real
        // conversation we must not gut, and a missing/foreign id is a no-op
        // (retirement is idempotent, unlike `existing`'s 400).
        const source = await ConversationRepository.findByIdForUpdate(
          client,
          workspaceId,
          directive.sourceConversationId
        )
        if (source && source.streamId !== message.streamId && source.messageIds.length <= 1) {
          for (const sourceMessageId of source.messageIds) {
            await ConversationRepository.removePrimaryMessage(client, workspaceId, source.id, sourceMessageId)
          }
          await ConversationRepository.resolveIfEmpty(client, workspaceId, source.id)
          await emitConversationRetired(client, { workspaceId, conversationId: source.id, streamId: source.streamId })
        }
      }
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
