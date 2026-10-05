import type { PoolClient } from "pg"
import { AuthorTypes, type KnowledgeType, type MemosCapturedEventPayload } from "@threahq/types"
import { StreamEventRepository, StreamRepository, type StreamEvent } from "../streams"
import { MessageRepository, type Message } from "../messaging"
import { StreamContextRepository, contextSnippet, type NewStreamContextItem } from "../stream-context"
import { OutboxRepository } from "../../lib/outbox"
import { eventId, streamContextItemId } from "../../lib/id"
import { logger } from "../../lib/logger"

export interface CapturedMemo {
  id: string
  title: string
  knowledgeType: KnowledgeType
  sourceMessageIds: string[]
}

/**
 * Shows memos captured from conversations in `streamId` there (INV-69): one
 * broadcast `memos:captured` event per conversation, and each memo's "in this
 * stream" landmark, in the caller's transaction (INV-7).
 */
export async function recordConversationCaptures(
  client: PoolClient,
  workspaceId: string,
  streamId: string,
  byConversation: Map<string, CapturedMemo[]>
): Promise<StreamEvent[]> {
  await indexCapturedMemos(client, workspaceId, streamId, [...byConversation.values()].flat())
  if (byConversation.size === 0) return []
  const events = await StreamEventRepository.insertMany(
    client,
    Array.from(byConversation, ([conversationId, memos]) => ({
      id: eventId(),
      workspaceId,
      streamId,
      eventType: "memos:captured" as const,
      payload: {
        conversationId,
        memos: memos.map((memo) => ({
          memoId: memo.id,
          title: memo.title,
          knowledgeType: memo.knowledgeType,
          sourceMessageIds: memo.sourceMessageIds,
        })),
      } satisfies MemosCapturedEventPayload,
      actorType: AuthorTypes.SYSTEM,
    }))
  )
  await OutboxRepository.insertMany(
    client,
    events.map((event) => ({
      eventType: "stream:memos_captured" as const,
      payload: { workspaceId, streamId, event },
    }))
  )
  return events
}

/**
 * "In this stream" projection rows for freshly captured memos. The landmark
 * sits at the LATEST source message's `created_at`, not the capture time —
 * extraction is debounced, so capture time lands minutes late. Sealed streams
 * are never indexed.
 */
export async function indexCapturedMemos(
  client: PoolClient,
  workspaceId: string,
  streamId: string,
  memos: CapturedMemo[]
): Promise<void> {
  if (memos.length === 0) return
  const stream = await StreamRepository.findById(client, workspaceId, streamId)
  if (!stream) {
    logger.warn({ workspaceId, streamId }, "Memo capture: stream row missing, skipping context landmarks")
    return
  }
  if (stream.e2eEnabled === true) return

  // Landmarks are filed on the top-level stream, never on a thread: save_memo
  // and reflective capture bind to the session's stream, which can be a
  // thread, and the identity index includes stream_id — filing the same memo
  // on both a thread and its root would surface it twice.
  const targetStreamId = stream.rootStreamId ?? stream.id

  const allSourceIds = [...new Set(memos.flatMap((memo) => memo.sourceMessageIds))]
  const sourceMessages = await MessageRepository.findByIds(client, workspaceId, allSourceIds)

  const rows: NewStreamContextItem[] = []
  for (const memo of memos) {
    const resolved = memo.sourceMessageIds
      .map((id) => sourceMessages.get(id))
      .filter((message): message is Message => message !== undefined)
    if (resolved.length === 0) {
      logger.warn({ memoId: memo.id, workspaceId, streamId }, "Memo has no resolvable source message — not indexed")
      continue
    }
    const latest = resolved.reduce((a, b) => (b.createdAt > a.createdAt ? b : a))
    rows.push({
      id: streamContextItemId(),
      workspaceId,
      streamId: targetStreamId,
      rootStreamId: targetStreamId,
      category: "memo",
      refKind: "memo",
      refId: memo.id,
      groupKey: memo.id,
      // First SURVIVING source, not first cited: a landmark anchored on a
      // deleted message would be unreachable, and the backfill anchors the
      // same way — the two must agree or they write different identity keys.
      sourceMessageId: resolved[0]!.id,
      authorId: latest.authorId,
      occurredAt: latest.createdAt,
      sequence: latest.sequence,
      snippet: contextSnippet(memo.title),
      detail: { title: memo.title, knowledgeType: memo.knowledgeType },
    })
  }
  await StreamContextRepository.insertMany(client, rows)
}
