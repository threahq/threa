import type { Pool } from "pg"
import { CommandKinds } from "@threa/types"
import type { CommandDispatchedOutboxPayload } from "../../lib/outbox"
import { logger } from "../../lib/logger"
import { JobQueues } from "../../lib/queue"
import type { QueueManager } from "../../lib/queue"
import { DebouncedOutboxHandler, type DebouncedOutboxHandlerConfig, type OutboxEvent } from "../../lib/outbox"

interface CommandDispatchedEventPayload {
  commandId: string
  name: string
  args: string
  status: string
  executionKind?: string
}

export type CommandHandlerConfig = DebouncedOutboxHandlerConfig

/**
 * Handler that dispatches command execution jobs when
 * `command:dispatched` events appear in the outbox.
 */
export class CommandHandler extends DebouncedOutboxHandler {
  private readonly jobQueue: QueueManager

  constructor(db: Pool, jobQueue: QueueManager, config?: CommandHandlerConfig) {
    super(db, { listenerId: "command", ...config })
    this.jobQueue = jobQueue
  }

  protected async processEvent(event: OutboxEvent): Promise<void> {
    if (event.eventType !== "command:dispatched") {
      return
    }

    const payload = event.payload as CommandDispatchedOutboxPayload
    const { event: commandEvent, workspaceId, streamId, authorId } = payload
    const eventPayload = commandEvent.payload as CommandDispatchedEventPayload

    if (eventPayload.executionKind && eventPayload.executionKind !== CommandKinds.SERVER) {
      return
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
  }
}
