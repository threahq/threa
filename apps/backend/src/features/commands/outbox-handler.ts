import type { Pool } from "pg"
import { CommandKinds } from "@threa/types"
import { OutboxRepository } from "../../lib/outbox"
import type { CommandDispatchedOutboxPayload } from "../../lib/outbox"
import { logger } from "../../lib/logger"
import { JobQueues } from "../../lib/queue"
import type { QueueManager } from "../../lib/queue"
import { CursorLock, ensureListenerFromLatest, DebounceWithMaxWait, type ProcessResult } from "@threa/backend-common"
import type { OutboxHandler } from "../../lib/outbox"

interface CommandDispatchedEventPayload {
  commandId: string
  name: string
  args: string
  status: string
  executionKind?: string
}

export interface CommandHandlerConfig {
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
 * Handler that dispatches command execution jobs when
 * `command:dispatched` events appear in the outbox.
 */
export class CommandHandler implements OutboxHandler {
  readonly listenerId = "command"

  private readonly db: Pool
  private readonly jobQueue: QueueManager
  private readonly cursorLock: CursorLock
  private readonly debouncer: DebounceWithMaxWait
  private readonly batchSize: number

  constructor(db: Pool, jobQueue: QueueManager, config?: CommandHandlerConfig) {
    this.db = db
    this.jobQueue = jobQueue
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
      (err) => logger.error({ err, listenerId: this.listenerId }, "CommandHandler debouncer error")
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
          if (event.eventType !== "command:dispatched") {
            seen.push(event.id)
            continue
          }

          const payload = event.payload as CommandDispatchedOutboxPayload
          const { event: commandEvent, workspaceId, streamId, authorId } = payload
          const eventPayload = commandEvent.payload as CommandDispatchedEventPayload

          if (eventPayload.executionKind && eventPayload.executionKind !== CommandKinds.SERVER) {
            seen.push(event.id)
            continue
          }

          logger.info(
            { commandId: eventPayload.commandId, commandName: eventPayload.name, streamId },
            "Command job dispatched"
          )

          await this.jobQueue.send(JobQueues.COMMAND_EXECUTE, {
            commandId: eventPayload.commandId,
            commandName: eventPayload.name,
            args: eventPayload.args,
            workspaceId,
            streamId,
            userId: authorId,
          })

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
}
