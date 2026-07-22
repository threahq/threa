import type { PoolClient } from "pg"
import { sql } from "../../db"
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
 *  - `newSubtopic`: the declared branch gesture from the board — a fresh thread
 *    was opened under a member message and this is its first reply. Mint a child
 *    conversation anchored to the message's (thread) stream, or attach to the one
 *    already anchored there when two users branch the same message concurrently
 *    (INV-20). The branch relationship is derivable from the graph (the thread's
 *    parentMessageId ∈ the parent conversation), so no parent id is written.
 */
export const conversationAssigner: ConversationAssigner = {
  async assignInTransaction(client, { workspaceId, message, directive }) {
    if (directive.intent === ConversationIntents.THREAD_FROM_MESSAGE) {
      const sourceId = await attachThreadReplyToSource(client, workspaceId, message, directive.sourceConversationId)
      if (sourceId) return sourceId
      return mintConversationForMessage(client, workspaceId, message)
    }

    if (directive.intent === ConversationIntents.NEW_SUBTOPIC) {
      return mintOrAttachSubtopicConversation(client, workspaceId, message)
    }

    if (directive.intent === ConversationIntents.NEW) {
      // Honor a client-minted id when the sender supplied one (a board post that
      // slotted its card optimistically keyed by this id — INV-20 idempotency
      // rides the upstream `clientMessageId` dedup, which skips this assigner on a
      // retry, so the id inserts exactly once). Omitted → mint server-side.
      return mintConversationForMessage(client, workspaceId, message, directive.conversationId)
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
    // Attaching a message to a stalled/resolved conversation revives it — it has activity again.
    await ConversationRepository.reactivateIfInactive(client, workspaceId, target.id)
    await ConversationRepository.bumpActivityForIds(client, workspaceId, [target.id])
    await emitAssignmentEvents(client, {
      workspaceId,
      message,
      conversationId: target.id,
      created: false,
      reason: "declared",
    })
    return target.id
  },
}

/** Mint a fresh conversation in the message's stream, seeded with the message.
 *  Returns the id — the client-minted `preferredId` when supplied (a board post
 *  that already slotted its optimistic card by it), else a fresh server id. */
async function mintConversationForMessage(
  client: PoolClient,
  workspaceId: string,
  message: Message,
  preferredId?: string
): Promise<string> {
  const newId = preferredId ?? conversationId()
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
  return newId
}

/**
 * `newSubtopic` (board branch gesture): mint a child conversation anchored to the
 * message's thread stream, or attach to the one already anchored there. Lock the
 * thread stream row first (mirrors the agent-reply mint's stream lock, INV-20) so
 * two users branching the same parent message — both landing in the one thread
 * `insertThreadOrFind` returned — don't both mint: the loser waits on the lock and
 * then sees the winner's conversation via `findActiveByStream`. No reactivate: a
 * resolved conversation on the thread is left as-is and a fresh active one minted.
 */
async function mintOrAttachSubtopicConversation(
  client: PoolClient,
  workspaceId: string,
  message: Message
): Promise<string> {
  await client.query(sql`SELECT id FROM streams WHERE id = ${message.streamId} FOR UPDATE`)
  const active = (await ConversationRepository.findActiveByStream(client, message.streamId))[0]
  if (!active) {
    return mintConversationForMessage(client, workspaceId, message)
  }
  await ConversationRepository.addPrimaryMessage(client, workspaceId, active.id, message.id, message.authorId)
  await ConversationRepository.bumpActivityForIds(client, workspaceId, [active.id])
  await emitAssignmentEvents(client, {
    workspaceId,
    message,
    conversationId: active.id,
    created: false,
    reason: "declared",
  })
  return active.id
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
 * (foreign/non-member/no-access/race) returns null so the caller mints a fresh
 * conversation instead — the reply is never left without a primary. On success
 * returns the source conversation's id.
 */
async function attachThreadReplyToSource(
  client: PoolClient,
  workspaceId: string,
  message: Message,
  sourceConversationId: string
): Promise<string | null> {
  const thread = await StreamRepository.findById(client, message.streamId)
  const source = await ConversationRepository.findByIdForUpdate(client, workspaceId, sourceConversationId)
  const anchorMessageId = thread?.parentAnchorId?.startsWith("msg_") ? thread.parentAnchorId : null
  if (
    !thread?.parentStreamId ||
    !anchorMessageId ||
    !source ||
    source.streamId !== thread.parentStreamId ||
    !source.messageIds.includes(anchorMessageId) ||
    !(await checkStreamAccess(client, source.streamId, workspaceId, message.authorId))
  ) {
    return null
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
  return source.id
}

/**
 * The stream's effective access root: a top-level stream is its own root, a
 * thread defers to `root_stream_id` (board-view-design.md / INV-62). Falls back
 * to the stream's own id when the row is missing (FK-less schema, INV-1).
 * Shared with the reassign path (`ConversationService.reassignMessage`), whose
 * one-root rule must match the assigner's `existing` directive exactly.
 */
export async function effectiveRootId(client: PoolClient, streamId: string): Promise<string> {
  const stream = await StreamRepository.findById(client, streamId)
  return stream?.rootStreamId ?? streamId
}
