import type { PoolClient } from "pg"
import { sql } from "../../db"
import { ConversationRepository, type Conversation } from "./repository"
import type { Message } from "../messaging"
import type { Stream } from "../streams"
import { emitAssignmentEvents } from "./assignment-events"
import { resolveEventAnchoredParentConversationId } from "./parent-conversation"
import { emitThreadMoves, moveThreadsWithAnchors } from "./thread-follows-anchor"
import { conversationId } from "../../lib/id"
import { ConversationStatuses } from "@threahq/types"

/**
 * Places a message without the extractor: into the conversation `findExisting`
 * picks, else a fresh one in the message's stream. The placement is final — no
 * settling row. The stream row is locked before the lookup so two placements
 * racing in one stream can't both mint (INV-20). The message's own threads
 * follow it there; the caller holds the message's row lock.
 */
export async function assignWithoutExtraction(
  client: PoolClient,
  params: {
    workspaceId: string
    message: Message
    stream: Stream
    reason: string
    findExisting: () => Promise<Conversation | null | undefined>
  }
): Promise<Conversation> {
  const { workspaceId, message, stream, reason, findExisting } = params
  await client.query(sql`SELECT id FROM streams WHERE id = ${stream.id} AND workspace_id = ${workspaceId} FOR UPDATE`)

  const existing = await findExisting()
  const conversation =
    existing ??
    (await ConversationRepository.insert(client, {
      id: conversationId(),
      streamId: stream.id,
      workspaceId,
      confidence: 1,
      status: ConversationStatuses.ACTIVE,
      parentConversationId: await resolveEventAnchoredParentConversationId(client, stream),
    }))

  await ConversationRepository.addPrimaryMessage(client, workspaceId, conversation.id, message.id, message.authorId)
  await ConversationRepository.reactivateIfInactive(client, workspaceId, conversation.id)
  await ConversationRepository.bumpActivityForIds(client, workspaceId, [conversation.id])
  const threadMoves = await moveThreadsWithAnchors(client, workspaceId, new Map([[message.id, conversation.id]]))

  const assigned = await emitAssignmentEvents(client, {
    workspaceId,
    message,
    conversationId: conversation.id,
    created: !existing,
    reason,
  })
  await emitThreadMoves(client, workspaceId, threadMoves)
  return assigned
}

/**
 * A reply in a message-anchored thread joins its anchor's conversation. Until
 * the anchor has one, the thread holds its own, which the anchor's placement
 * later folds into the anchor's (`moveThreadsWithAnchors`). The anchor row is
 * share-locked: a pass moving the anchor holds it, so the reply reads the
 * anchor's placement only after that pass commits and can't land behind it.
 */
export async function assignThreadReply(
  client: PoolClient,
  params: { workspaceId: string; message: Message; thread: Stream }
): Promise<Conversation> {
  const { workspaceId, message, thread } = params
  const anchorId = thread.parentAnchorId!
  await client.query(sql`SELECT id FROM messages WHERE id = ${anchorId} AND workspace_id = ${workspaceId} FOR SHARE`)
  return assignWithoutExtraction(client, {
    workspaceId,
    message,
    stream: thread,
    reason: "thread_reply",
    findExisting: async () => {
      const anchors = await ConversationRepository.findPrimaryByMessageId(client, workspaceId, anchorId)
      if (anchors) return anchors
      const held = (await ConversationRepository.findByStream(client, workspaceId, thread.id)).filter(
        (c) => c.messageIds.length > 0
      )
      return held.find((c) => c.status === ConversationStatuses.ACTIVE) ?? held[0]
    },
  })
}
