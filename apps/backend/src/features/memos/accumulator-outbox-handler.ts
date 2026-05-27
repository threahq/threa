import type { Pool } from "pg"
import { OutboxRepository } from "../../lib/outbox"
import { StreamStateRepository, StreamRepository } from "../streams"
import { PendingItemRepository } from "./pending-item-repository"
import { pendingItemId } from "../../lib/id"
import { StreamTypes } from "@threa/types"
import { logger } from "../../lib/logger"
import { CursorLock, ensureListenerFromLatest, DebounceWithMaxWait, type ProcessResult } from "@threa/backend-common"
import type { OutboxHandler } from "../../lib/outbox"
import { withClient } from "../../db"
import { E2eStreamsRepository } from "../e2e-streams"

export interface MemoAccumulatorHandlerConfig {
  batchSize?: number
  debounceMs?: number
  maxWaitMs?: number
  lockDurationMs?: number
  refreshIntervalMs?: number
  maxRetries?: number
  baseBackoffMs?: number
}

const DEFAULT_CONFIG = {
  batchSize: 100,
  debounceMs: 50,
  maxWaitMs: 200,
  lockDurationMs: 10_000,
  refreshIntervalMs: 5_000,
  maxRetries: 5,
  baseBackoffMs: 1_000,
}

/**
 * Handler that queues conversations for batch memo processing.
 *
 * Flow:
 * 1. Conversation event arrives (conversation:created, conversation:updated)
 * 2. Queue item to memo_pending_items table
 * 3. Update stream state activity for debounce tracking
 *
 * The batch worker will process queued items based on per-stream debouncing:
 * - Cap: process at most every 5 minutes per stream
 * - Quick: process after 30s quiet per stream
 *
 * Note: message:created events are NOT handled here. Boundary extraction
 * creates/updates conversations on every message, and the conversation events
 * trigger memo processing via the conversation path only.
 */
export class MemoAccumulatorHandler implements OutboxHandler {
  readonly listenerId = "memo-accumulator"

  private readonly db: Pool
  private readonly cursorLock: CursorLock
  private readonly debouncer: DebounceWithMaxWait
  private readonly batchSize: number

  constructor(db: Pool, config?: MemoAccumulatorHandlerConfig) {
    this.db = db
    this.batchSize = config?.batchSize ?? DEFAULT_CONFIG.batchSize

    this.cursorLock = new CursorLock({
      pool: db,
      listenerId: this.listenerId,
      lockDurationMs: config?.lockDurationMs ?? DEFAULT_CONFIG.lockDurationMs,
      refreshIntervalMs: config?.refreshIntervalMs ?? DEFAULT_CONFIG.refreshIntervalMs,
      maxRetries: config?.maxRetries ?? DEFAULT_CONFIG.maxRetries,
      baseBackoffMs: config?.baseBackoffMs ?? DEFAULT_CONFIG.baseBackoffMs,
      batchSize: this.batchSize,
    })

    this.debouncer = new DebounceWithMaxWait(
      () => this.processEvents(),
      config?.debounceMs ?? DEFAULT_CONFIG.debounceMs,
      config?.maxWaitMs ?? DEFAULT_CONFIG.maxWaitMs,
      (err) => logger.error({ err, listenerId: this.listenerId }, "MemoAccumulatorHandler debouncer error")
    )
  }

  async ensureListener(): Promise<void> {
    await ensureListenerFromLatest(this.db, this.listenerId)
  }

  handle(): void {
    this.debouncer.trigger()
  }

  private async processEvents(): Promise<void> {
    await this.cursorLock.run(async (cursor, processedIds): Promise<ProcessResult> => {
      const events = await OutboxRepository.fetchAfterId(this.db, cursor, this.batchSize, processedIds)

      if (events.length === 0) {
        return { status: "no_events" }
      }

      const seen: bigint[] = []

      try {
        for (const event of events) {
          switch (event.eventType) {
            case "conversation:created":
            case "conversation:updated":
              await this.handleConversationEvent(event)
              break
          }

          seen.push(event.id)
        }

        return { status: "processed", processedIds: seen }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))

        if (seen.length > 0) {
          return { status: "error", error, processedIds: seen }
        }

        return { status: "error", error }
      }
    })
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
