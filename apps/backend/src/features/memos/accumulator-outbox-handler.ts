import type { Pool } from "pg"
import { StreamStateRepository, StreamRepository } from "../streams"
import { PendingItemRepository } from "./pending-item-repository"
import { pendingItemId } from "../../lib/id"
import { StreamTypes, MemoryModes } from "@threa/types"
import { logger } from "../../lib/logger"
import { DebouncedOutboxHandler, type DebouncedOutboxHandlerConfig, type OutboxEvent } from "../../lib/outbox"
import { withClient } from "../../db"
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

    await withClient(this.db, async (client) => {
      const stream = await StreamRepository.findById(client, streamId)
      if (!stream) {
        logger.warn({ streamId }, "Stream not found for memo accumulator")
        return
      }

      const topLevelStreamId = stream.type === StreamTypes.THREAD ? (stream.rootStreamId ?? streamId) : streamId

      // Per-stream opt-out (INV-62 inheritance): memory automation is gated on
      // the resolved top-level stream, so a thread follows its root. `off`
      // excludes the stream from memo extraction *and* passive to-do capture
      // (both ride processBatch, which never runs without queued items).
      const topLevelStream =
        topLevelStreamId === streamId ? stream : await StreamRepository.findById(client, topLevelStreamId)
      if (topLevelStream?.memoryMode === MemoryModes.OFF) {
        logger.debug(
          { workspaceId, streamId: topLevelStreamId },
          "Memory automation off for stream — skipping memo queue"
        )
        return
      }

      await PendingItemRepository.queue(client, [
        {
          id: pendingItemId(),
          workspaceId,
          streamId: topLevelStreamId,
          itemType: "conversation",
          itemId: conversationId,
        },
      ])

      await StreamStateRepository.upsertActivity(client, workspaceId, topLevelStreamId)

      logger.debug(
        { workspaceId, streamId: topLevelStreamId, conversationId },
        "Conversation queued for memo processing"
      )
    })
  }
}
