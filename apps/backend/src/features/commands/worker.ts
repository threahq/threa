import type { Pool } from "pg"
import type { CommandExecuteJobData, JobHandler } from "../../lib/queue"
import type { CommandRegistry, CommandContext } from "./registry"
import { withTransaction } from "../../db"
import { logger } from "../../lib/logger"
import { insertCommandCompletedEvent, insertCommandFailedEvent } from "./events"

export interface CommandCompletedPayload {
  commandId: string
  result?: unknown
}

export interface CommandFailedPayload {
  commandId: string
  error: string
}

export interface CommandWorkerDeps {
  pool: Pool
  commandRegistry: CommandRegistry
}

/**
 * Create the command execution job handler for queue system.
 *
 * Executes a command and creates completion/failure events.
 */
export function createCommandWorker(deps: CommandWorkerDeps): JobHandler<CommandExecuteJobData> {
  const { pool, commandRegistry } = deps

  return async (job) => {
    const { commandId, commandName, args, workspaceId, streamId, userId } = job.data

    logger.info({ jobId: job.id, commandId, commandName }, "Processing command job")

    const command = commandRegistry.get(commandName)
    if (!command) {
      logger.error({ commandName }, "Command not found in registry")
      await createFailedEvent(pool, {
        commandId,
        workspaceId,
        streamId,
        userId,
        error: `Unknown command: ${commandName}`,
      })
      return
    }

    const ctx: CommandContext = {
      commandId,
      commandName,
      workspaceId,
      streamId,
      userId,
      args,
    }

    try {
      const result = await command.execute(ctx)

      if (result.success) {
        await createCompletedEvent(pool, {
          commandId,
          workspaceId,
          streamId,
          userId,
          result: result.result,
        })
        logger.info({ jobId: job.id, commandId, commandName }, "Command completed successfully")
      } else {
        await createFailedEvent(pool, {
          commandId,
          workspaceId,
          streamId,
          userId,
          error: result.error || "Command failed",
        })
        logger.warn({ jobId: job.id, commandId, commandName, error: result.error }, "Command failed")
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : "Unknown error"
      await createFailedEvent(pool, {
        commandId,
        workspaceId,
        streamId,
        userId,
        error,
      })
      logger.error({ jobId: job.id, commandId, commandName, err }, "Command threw exception")
      throw err
    }
  }
}

interface CompletedEventParams {
  commandId: string
  workspaceId: string
  streamId: string
  userId: string
  result?: unknown
}

async function createCompletedEvent(pool: Pool, params: CompletedEventParams): Promise<void> {
  const { commandId, workspaceId, streamId, userId, result } = params

  await withTransaction(pool, (client) =>
    insertCommandCompletedEvent(client, {
      commandId,
      workspaceId,
      streamId,
      userId,
      result,
    })
  )
}

interface FailedEventParams {
  commandId: string
  workspaceId: string
  streamId: string
  userId: string
  error: string
}

async function createFailedEvent(pool: Pool, params: FailedEventParams): Promise<void> {
  const { commandId, workspaceId, streamId, userId, error } = params

  await withTransaction(pool, (client) =>
    insertCommandFailedEvent(client, {
      commandId,
      workspaceId,
      streamId,
      userId,
      error,
    })
  )
}
