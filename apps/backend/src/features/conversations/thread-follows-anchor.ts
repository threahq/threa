import type { PoolClient } from "pg"
import { sql } from "../../db"
import { ConversationRepository, distinctAuthors } from "./repository"
import { MessageRepository } from "../messaging"
import { StreamRepository } from "../streams"
import { OutboxRepository } from "../../lib/outbox"
import { addStalenessFields } from "./staleness"
import { MessageConversationStateRepository } from "./settling-repository"
import { resolveConversationDelivery } from "./conversation-delivery"

export interface ThreadMove {
  messageId: string
  streamId: string
  fromConversationId: string
  toConversationId: string
}

/**
 * Engagement freezes placement: a human who re-filed a message (`'user'`) or
 * engaged with it where it sits (`'engagement'`) has ruled, and no later pass
 * re-files it. `'llm-window'` settles are machine-made and stay decidable.
 */
export function isPlacementFrozenByHuman(row: { state: string; settledBy: string | null } | null): boolean {
  return row?.state === "settled" && (row.settledBy === "user" || row.settledBy === "engagement")
}

/**
 * A message-anchored thread lives in its anchor's conversation. Once anchors
 * are filed (`placements`: anchor id → conversation id), their threads follow
 * at every depth, so a thread never stays split between the anchor's old and
 * new conversation. A message declared into a conversation or filed by a human
 * stays where it is, and so does the thread below it.
 *
 * The caller holds the anchors' row locks. Replies are locked a depth at a
 * time, parent before child, the order a reply's own placement takes them in.
 */
export async function moveThreadsWithAnchors(
  client: PoolClient,
  workspaceId: string,
  placements: Map<string, string>
): Promise<ThreadMove[]> {
  const tree = await MessageRepository.findThreadTrees(client, workspaceId, [...placements.keys()])
  if (tree.length === 0) return []

  tree.sort((a, b) => a.depth - b.depth)
  for (let depth = 1; depth <= tree.at(-1)!.depth; depth++) {
    const ids = tree.filter((r) => r.depth === depth).map((r) => r.id)
    await client.query(sql`
      SELECT id FROM messages
      WHERE workspace_id = ${workspaceId} AND id = ANY(${ids}::text[])
      ORDER BY id
      FOR UPDATE
    `)
  }
  const replyIds = tree.map((r) => r.id)
  const primaries = await ConversationRepository.findPrimariesByMessageIds(client, workspaceId, replyIds)
  const states = await MessageConversationStateRepository.findByMessageIds(client, workspaceId, replyIds)

  const targets = new Map(placements)
  const moves: (ThreadMove & { authorId: string })[] = []
  for (const reply of tree) {
    const target = targets.get(reply.anchorId)
    if (!target) continue
    if (reply.conversationIntent != null || isPlacementFrozenByHuman(states.get(reply.id) ?? null)) continue
    targets.set(reply.id, target)
    const from = primaries.get(reply.id)
    if (!from || from.id === target) continue
    moves.push({
      messageId: reply.id,
      streamId: reply.streamId,
      authorId: reply.authorId,
      fromConversationId: from.id,
      toConversationId: target,
    })
  }
  if (moves.length === 0) return []

  const involved = [...new Set(moves.flatMap((m) => [m.fromConversationId, m.toConversationId]))]
  const locked = new Map(
    (await ConversationRepository.findByIdsForUpdate(client, workspaceId, involved)).map((c) => [c.id, c])
  )

  for (const fromId of new Set(moves.map((m) => m.fromConversationId))) {
    const leaving = new Set(moves.filter((m) => m.fromConversationId === fromId).map((m) => m.messageId))
    const remainingIds = (locked.get(fromId)?.messageIds ?? []).filter((id) => !leaving.has(id))
    const remaining = await MessageRepository.findByIds(client, workspaceId, remainingIds)
    await ConversationRepository.removePrimaryMessages(
      client,
      workspaceId,
      fromId,
      [...leaving],
      distinctAuthors(remainingIds, remaining)
    )
    await ConversationRepository.resolveIfEmpty(client, workspaceId, fromId)
  }
  const targetIds = [...new Set(moves.map((m) => m.toConversationId))]
  const targetsAfterRemoval = await ConversationRepository.findByIds(client, workspaceId, targetIds)
  for (const target of targetsAfterRemoval) {
    const toId = target.id
    const arriving = moves.filter((m) => m.toConversationId === toId)
    const participants = new Set([...target.participantIds, ...arriving.map((m) => m.authorId)])
    const arrivingIds = arriving.map((m) => m.messageId)
    await ConversationRepository.addPrimaryMessages(client, workspaceId, toId, arrivingIds, [...participants])
    await MessageConversationStateRepository.moveConversation(client, workspaceId, arrivingIds, toId)
  }

  return moves.map(({ messageId, streamId, fromConversationId, toConversationId }) => ({
    messageId,
    streamId,
    fromConversationId,
    toConversationId,
  }))
}

/**
 * Outbox events for moves made outside an extraction pass: each conversation a
 * thread left, then each moved message. The receiving conversation's update is
 * the caller's to emit, since it is also where the anchor was placed.
 */
export async function emitThreadMoves(client: PoolClient, workspaceId: string, moves: ThreadMove[]): Promise<void> {
  const sourceIds = [...new Set(moves.map((m) => m.fromConversationId))]
  const sources = await ConversationRepository.findByIds(client, workspaceId, sourceIds)
  const settlingByConversation = await MessageConversationStateRepository.listSettlingByConversationIds(
    client,
    workspaceId,
    sourceIds
  )
  for (const conversation of sources) {
    const stream = await StreamRepository.findById(client, workspaceId, conversation.streamId)
    const { parentStreamId, streamVisibility } = await resolveConversationDelivery(client, stream)
    await OutboxRepository.insert(client, "conversation:updated", {
      workspaceId,
      streamId: conversation.streamId,
      conversationId: conversation.id,
      conversation: addStalenessFields(conversation),
      parentStreamId,
      streamVisibility,
      settlingMessageIds: settlingByConversation.get(conversation.id) ?? [],
    })
  }
  await OutboxRepository.insertMany(
    client,
    moves.map((move) => ({
      eventType: "conversation:message_reassigned",
      payload: { workspaceId, ...move, reason: "thread_follows_anchor" },
    }))
  )
}
