import type { Pool, PoolClient } from "pg"
import { StreamStateRepository, findMemoryModeStream, isMemoryAutomationOn } from "../streams"
import { ConversationRepository } from "../conversations"
import { PendingItemRepository } from "./pending-item-repository"
import { MemoRepository } from "./repository"
import { pendingItemId } from "../../lib/id"
import { logger } from "../../lib/logger"
import { DebouncedOutboxHandler, type DebouncedOutboxHandlerConfig, type OutboxEvent } from "../../lib/outbox"
import { withClient, withTransaction } from "../../db"
import { E2eStreamsRepository } from "../e2e-streams"

export type MemoAccumulatorHandlerConfig = DebouncedOutboxHandlerConfig

/**
 * Queues conversations for batch memo processing, which the batch worker drains
 * on per-stream debouncing: at most every 5 minutes per stream, or after 30s quiet.
 *
 * message:created events are NOT handled here. Boundary extraction
 * creates/updates conversations on every message, and the conversation events
 * trigger memo processing via the conversation path only.
 */
export class MemoAccumulatorHandler extends DebouncedOutboxHandler {
  constructor(db: Pool, config?: MemoAccumulatorHandlerConfig) {
    super(db, { listenerId: "memo-accumulator", ...config })
  }

  protected async processEvent(event: OutboxEvent): Promise<void> {
    switch (event.eventType) {
      case "conversation:created":
      case "conversation:updated":
        await this.handleConversationEvent(event)
        break
      case "message:edited":
      case "message:deleted":
        await this.handleMessageMutation(event)
        break
    }
  }

  private async handleConversationEvent(outboxEvent: { id: bigint; payload: unknown }): Promise<void> {
    const payload = outboxEvent.payload as unknown as Record<string, unknown>

    if (
      typeof payload.streamId !== "string" ||
      typeof payload.workspaceId !== "string" ||
      typeof payload.conversationId !== "string"
    ) {
      return
    }

    // Staleness-sweep fades carry no new content: re-queueing here would re-run
    // memo extraction over an idle (possibly months-old) conversation.
    if (payload.origin === "staleness-sweep") {
      return
    }

    const { streamId, workspaceId, conversationId } = payload as {
      streamId: string
      workspaceId: string
      conversationId: string
    }

    // E2E streams: boundary extraction never creates conversations for E2E
    // streams, so this is defense-in-depth — a conversation event whose
    // stream became E2E should still not trigger memo processing.
    if (await E2eStreamsRepository.isE2eStream(this.db, workspaceId, streamId)) {
      return
    }

    await withClient(this.db, (client) => queueMemoConversations(client, workspaceId, streamId, [conversationId]))
  }

  /**
   * An edit or delete changes what memos drawn from the message may say, so its
   * conversations go back through the batch. A delete also retires the memos
   * citing it straight away, whatever the stream's memory mode: archived when
   * none of their sources survive, otherwise superseded. A conversation memo is
   * re-extracted from the rest by the requeued batch; a saved or reflective
   * memo has no conversation to re-extract from, so it is gone.
   */
  private async handleMessageMutation(event: OutboxEvent): Promise<void> {
    const payload = event.payload as unknown as Record<string, unknown>
    const messageId =
      event.eventType === "message:deleted"
        ? payload.messageId
        : (payload.event as { payload?: { messageId?: unknown } } | undefined)?.payload?.messageId
    if (
      typeof payload.workspaceId !== "string" ||
      typeof payload.streamId !== "string" ||
      typeof messageId !== "string"
    ) {
      return
    }
    const { workspaceId, streamId } = payload as { workspaceId: string; streamId: string }

    if (await E2eStreamsRepository.isE2eStream(this.db, workspaceId, streamId)) {
      return
    }

    await withTransaction(this.db, async (client) => {
      if (event.eventType === "message:deleted") {
        await retireMemosCitingDeletedMessage(client, workspaceId, streamId, messageId)
      }
      const conversations = await ConversationRepository.findByMessageId(client, workspaceId, messageId)
      await queueMemoConversations(
        client,
        workspaceId,
        streamId,
        conversations.map((c) => c.id)
      )
    })
  }
}

/**
 * Archives the active memos citing a deleted message when none of their
 * sources survive, and supersedes the rest. Returns how many memos it retired.
 */
export async function retireMemosCitingDeletedMessage(
  client: PoolClient,
  workspaceId: string,
  streamId: string,
  messageId: string
): Promise<number> {
  // Held by every memo save in the stream: a memo saved concurrently
  // either commits before the lookup below, or sees the deletion.
  const memoStream = await findMemoryModeStream(client, workspaceId, streamId)
  if (memoStream) await MemoRepository.lockStreamSaves(client, memoStream.id)

  const citing = await MemoRepository.findActiveCitingMessage(client, workspaceId, messageId)
  const archived = citing.filter((c) => !c.hasLiveSource).map((c) => c.memo.id)
  const superseded = citing.filter((c) => c.hasLiveSource).map((c) => c.memo.id)
  await MemoRepository.archiveMany(client, workspaceId, archived)
  await MemoRepository.markSuperseded(client, workspaceId, superseded, "A source message was deleted")
  return archived.length + superseded.length
}

export async function queueMemoConversations(
  client: PoolClient,
  workspaceId: string,
  streamId: string,
  conversationIds: string[]
): Promise<void> {
  if (conversationIds.length === 0) return

  // `off` excludes the stream from memo extraction *and* passive to-do
  // capture (both ride processBatch, which never runs without queued items).
  const topLevelStream = await findMemoryModeStream(client, workspaceId, streamId)
  if (!topLevelStream) {
    // Nothing to attribute memos to, so don't queue an orphan.
    logger.warn({ workspaceId, streamId }, "Stream not found for memo accumulator")
    return
  }
  if (!isMemoryAutomationOn(topLevelStream)) {
    logger.debug({ workspaceId, streamId }, "Memory automation off for stream — skipping memo queue")
    return
  }

  // Stream state before pending rows, the order a batch save locks them in.
  await StreamStateRepository.upsertActivity(client, workspaceId, topLevelStream.id)

  await PendingItemRepository.queue(
    client,
    conversationIds.map((itemId) => ({
      id: pendingItemId(),
      workspaceId,
      streamId: topLevelStream.id,
      itemType: "conversation",
      itemId,
    }))
  )

  logger.debug(
    { workspaceId, streamId: topLevelStream.id, conversationIds },
    "Conversations queued for memo processing"
  )
}
