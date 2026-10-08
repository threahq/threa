/**
 * Seeds historical messages and captures them through the production memo
 * pipeline (`MemoService.processBatch`: real classifier, memorizer and
 * embeddings), for suites that measure recall over a captured workspace.
 */

import { DisabledAnalyticsReporter } from "@threahq/backend-common"
import { DecisionsAvailability } from "@threahq/agent-runtime"
import { parseMarkdown } from "@threahq/prosemirror"
import { AuthorTypes, ConversationStatuses } from "@threahq/types"
import type { EvalContext } from "../framework/types"
import {
  DecisionsMemoClassifier,
  EmbeddingService,
  MemoClassifier,
  MemoService,
  Memorizer,
  ResidencyRoutedMemoClassifier,
} from "../../src/features/memos"
import { queueMemoConversations } from "../../src/features/memos/accumulator-outbox-handler"
import { ConversationRepository } from "../../src/features/conversations"
import { EventService } from "../../src/features/messaging"
import { WorkspaceAIResidencyPolicy } from "../../src/features/ai-usage"
import { MessageFormatter } from "../../src/lib/ai/message-formatter"
import { conversationId as generateConversationId } from "../../src/lib/id"
import { withTransaction } from "../../src/db"

export interface SeedMessage {
  authorId: string
  content: string
  createdAt: Date
}

export function createCaptureMemoService(ctx: EvalContext): MemoService {
  const messageFormatter = new MessageFormatter()
  return new MemoService({
    pool: ctx.pool,
    analyticsReporter: new DisabledAnalyticsReporter(),
    classifier: new ResidencyRoutedMemoClassifier({
      residency: new WorkspaceAIResidencyPolicy({ pool: ctx.pool }),
      decisions: new DecisionsMemoClassifier(ctx.ai),
      inference: new MemoClassifier(ctx.ai, ctx.configResolver, messageFormatter),
      availability: new DecisionsAvailability(),
    }),
    memorizer: new Memorizer(ctx.ai, ctx.configResolver, messageFormatter),
    embeddingService: new EmbeddingService({ ai: ctx.ai }),
    messageFormatter,
  })
}

/** Posts messages in order, then backdates them to their `createdAt`. Returns the message ids in input order. */
export async function postMessages(ctx: EvalContext, streamId: string, messages: SeedMessage[]): Promise<string[]> {
  const eventService = new EventService(ctx.pool)
  const ids: string[] = []
  for (const message of messages) {
    const created = await eventService.createMessage({
      workspaceId: ctx.workspaceId,
      streamId,
      authorId: message.authorId,
      authorType: AuthorTypes.USER,
      contentJson: parseMarkdown(message.content),
      contentMarkdown: message.content,
    })
    ids.push(created.id)
  }
  await ctx.pool.query(
    `UPDATE messages SET created_at = v.created_at
     FROM unnest($1::text[], $2::timestamptz[]) AS v(id, created_at)
     WHERE messages.id = v.id`,
    [ids, messages.map((m) => m.createdAt)]
  )
  return ids
}

/** Batches in a row that settle nothing before `drainCapture` stops waiting on a provider. */
const MAX_STALLED_BATCHES = 5

/**
 * Records the messages as one resolved conversation and queues it for capture
 * on its top-level stream, where a thread's conversations queue too. Batches
 * take the queue oldest first and a batch revises the stream's earlier memos,
 * so queue a stream's conversations in time order.
 */
export async function recordConversation(
  ctx: EvalContext,
  streamId: string,
  messageIds: string[],
  participantIds: string[]
): Promise<string> {
  const { pool, workspaceId } = ctx
  const id = generateConversationId()
  await ConversationRepository.insert(pool, { id, streamId, workspaceId, status: ConversationStatuses.RESOLVED })
  await ConversationRepository.addPrimaryMessages(pool, workspaceId, id, messageIds, participantIds)
  // Capture's settle gates read activity time, which would otherwise be now and defer every single-message conversation.
  await pool.query(
    `UPDATE conversations SET last_activity_at = (SELECT max(created_at) FROM messages WHERE id = ANY($2::text[]))
     WHERE workspace_id = $1 AND id = $3`,
    [workspaceId, messageIds, id]
  )
  await withTransaction(pool, (client) => queueMemoConversations(client, workspaceId, streamId, [id]))
  return id
}

/**
 * Runs capture batches on a top-level stream until its queue is empty. A
 * failed model call (a provider rate limit, mostly) leaves its conversation
 * queued for the next batch, until capture gives up on it after
 * `MEMO_MAX_FAILED_ATTEMPTS`; batches that settle nothing back off. Returns
 * how many conversations were still queued when it stopped.
 */
export async function drainCapture(ctx: EvalContext, memoService: MemoService, streamId: string): Promise<number> {
  const { pool, workspaceId } = ctx
  const countQueued = async () => {
    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*) FROM memo_pending_items WHERE workspace_id = $1 AND stream_id = $2 AND processed_at IS NULL`,
      [workspaceId, streamId]
    )
    return Number(rows[0]!.count)
  }
  let queued = await countQueued()
  for (let stalled = 0; queued > 0 && stalled < MAX_STALLED_BATCHES; ) {
    await memoService.processBatch(workspaceId, streamId)
    const remaining = await countQueued()
    stalled = remaining < queued ? 0 : stalled + 1
    if (stalled > 0) await Bun.sleep(stalled * 5_000)
    queued = remaining
  }
  return queued
}
