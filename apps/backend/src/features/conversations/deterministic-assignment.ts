import type { PoolClient } from "pg"
import { sql } from "../../db"
import { ConversationRepository, type Conversation } from "./repository"
import type { Message } from "../messaging"
import type { Stream } from "../streams"
import { emitAssignmentEvents } from "./assignment-events"
import { resolveEventAnchoredParentConversationId } from "./parent-conversation"
import { conversationId } from "../../lib/id"
import { ConversationStatuses } from "@threahq/types"

/**
 * Places a message without the extractor: into the conversation `findExisting`
 * picks, else a fresh one in the message's stream. The placement is final — no
 * settling row. The stream row is locked before the lookup so two placements
 * racing in one stream can't both mint (INV-20).
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

  return emitAssignmentEvents(client, {
    workspaceId,
    message,
    conversationId: conversation.id,
    created: !existing,
    reason,
  })
}

/**
 * A user's reply in a message-anchored thread continues the thread's
 * conversation: the one the thread already holds (an agent's, a branched
 * subtopic, or one minted when the anchor had none), else the anchor message's.
 * With neither, the reply mints the thread's own; the anchor's later extraction
 * sees the reply and its conversation in context and can join it.
 */
export function assignThreadReply(
  client: PoolClient,
  params: { workspaceId: string; message: Message; thread: Stream }
): Promise<Conversation> {
  const { workspaceId, message, thread } = params
  return assignWithoutExtraction(client, {
    workspaceId,
    message,
    stream: thread,
    reason: "thread_reply",
    findExisting: async () => {
      const held = (await ConversationRepository.findByStream(client, workspaceId, thread.id)).filter(
        (c) => c.messageIds.length > 0
      )
      const own = held.find((c) => c.status === ConversationStatuses.ACTIVE) ?? held[0]
      if (own) return own
      return ConversationRepository.findPrimaryByMessageId(client, workspaceId, thread.parentAnchorId!)
    },
  })
}
