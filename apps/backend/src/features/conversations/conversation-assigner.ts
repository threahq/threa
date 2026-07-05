import type { PoolClient } from "pg"
import { ConversationRepository } from "./repository"
import type { ConversationAssigner, Message } from "../messaging"
import { checkStreamAccess, StreamRepository } from "../streams"
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
 *  - `existing`: attach the message to the named conversation. A conversation is
 *    confined to ONE root stream (board-view-design.md), so the target must share
 *    the message's effective root — a reply may join it from the root or any of
 *    its threads, never across roots. A stale/foreign/cross-root id is rejected
 *    (400) rather than silently mis-assigned.
 *  - `threadFromMessage`: a board reply to a lone post that just became a thread.
 *    Keep ONE conversation — attach the reply (now in the thread stream) to the
 *    SAME source conversation as a cross-stream member (root opener + thread
 *    reply, one root). Stable conversation id, no card swap. Falls back to a
 *    fresh mint only when the source can't be verified, so the reply is never
 *    orphaned.
 */
export const conversationAssigner: ConversationAssigner = {
  async assignInTransaction(client, { workspaceId, message, directive }) {
    if (directive.intent === ConversationIntents.THREAD_FROM_MESSAGE) {
      if (await attachThreadReplyToSource(client, workspaceId, message, directive.sourceConversationId)) {
        return
      }
      await mintConversationForMessage(client, workspaceId, message)
      return
    }

    if (directive.intent === ConversationIntents.NEW) {
      await mintConversationForMessage(client, workspaceId, message)
      return
    }

    // `existing`. Workspace-scoped + row-locked (INV-8, INV-20): a stale/foreign
    // id resolves to null (rejected below) and a concurrent resolve/delete
    // serializes behind this attach instead of racing it.
    const target = await ConversationRepository.findByIdForUpdate(client, workspaceId, directive.conversationId)
    if (!target) {
      throw new HttpError("Conversation not found", { status: 400, code: "CONVERSATION_NOT_FOUND" })
    }
    // One-root invariant: the target conversation's effective root must equal the
    // message's. Same stream (the common case) trivially passes; a cross-stream
    // attach from the root or one of its threads passes; a cross-root attach is
    // rejected (board-view-design.md "Boundary extraction needs no tightening").
    if (target.streamId !== message.streamId) {
      const [targetRoot, messageRoot] = await Promise.all([
        effectiveRootId(client, target.streamId),
        effectiveRootId(client, message.streamId),
      ])
      if (targetRoot !== messageRoot) {
        throw new HttpError("Conversation is in a different root stream", {
          status: 400,
          code: "CONVERSATION_NOT_IN_ROOT",
        })
      }
    }
    await ConversationRepository.addPrimaryMessage(client, workspaceId, target.id, message.id, message.authorId)
    // Attaching a message to a resolved conversation revives it — it has activity again.
    await ConversationRepository.reactivateIfInactive(client, workspaceId, target.id)
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

/** Mint a fresh conversation in the message's stream, seeded with the message. */
async function mintConversationForMessage(client: PoolClient, workspaceId: string, message: Message): Promise<void> {
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
}

/**
 * Convert-to-thread, corrected (board-view-design.md): attach the board reply
 * (now in the thread stream) to its SOURCE conversation as a cross-stream member
 * rather than minting a new conversation and retiring the source. Keeps one
 * conversation spanning the root + thread (one root), so the board card renders
 * in place with no swap.
 *
 * The reply's stream must be a thread whose parent message belongs to the source
 * conversation, the source must be anchored at that parent stream (the root), and
 * the actor must be able to reach it (INV-62). Any mismatch
 * (foreign/non-member/no-access/race) returns false so the caller mints a fresh
 * conversation instead — the reply is never left without a primary.
 */
async function attachThreadReplyToSource(
  client: PoolClient,
  workspaceId: string,
  message: Message,
  sourceConversationId: string
): Promise<boolean> {
  const thread = await StreamRepository.findById(client, message.streamId)
  const source = await ConversationRepository.findByIdForUpdate(client, workspaceId, sourceConversationId)
  if (
    !thread?.parentStreamId ||
    !thread.parentMessageId ||
    !source ||
    source.streamId !== thread.parentStreamId ||
    !source.messageIds.includes(thread.parentMessageId) ||
    !(await checkStreamAccess(client, source.streamId, workspaceId, message.authorId))
  ) {
    return false
  }
  await ConversationRepository.addPrimaryMessage(client, workspaceId, source.id, message.id, message.authorId)
  await ConversationRepository.reactivateIfInactive(client, workspaceId, source.id)
  await ConversationRepository.bumpActivityForIds(client, workspaceId, [source.id])
  await emitAssignmentEvents(client, {
    workspaceId,
    message,
    conversationId: source.id,
    created: false,
    reason: "declared",
  })
  return true
}

/**
 * The stream's effective access root: a top-level stream is its own root, a
 * thread defers to `root_stream_id` (board-view-design.md / INV-62). Falls back
 * to the stream's own id when the row is missing (FK-less schema, INV-1).
 */
async function effectiveRootId(client: PoolClient, streamId: string): Promise<string> {
  const stream = await StreamRepository.findById(client, streamId)
  return stream?.rootStreamId ?? streamId
}
