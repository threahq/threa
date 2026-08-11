import type { Pool } from "pg"
import type { CommandExecuteJobData, JobHandler } from "../../lib/queue"
import type { CommandRegistry, CommandContext } from "./registry"
import { withTransaction } from "../../db"
import { logger } from "../../lib/logger"
import { insertCommandCompletedEvent, insertCommandFailedEvent } from "./events"
import { assertStreamWritable, StreamEventRepository } from "../streams"
import { commandRequiresWritableAuthority } from "./availability"

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

    if (commandRequiresWritableAuthority(commandName)) {
      const denied = await withTransaction(pool, async (client) => {
        try {
          await assertStreamWritable(client, {
            workspaceId,
            streamId,
            principal: { kind: "user", userId },
          })
          return false
        } catch (error) {
          const denial = error as { code?: string; details?: { reason?: string } }
          if (denial.code !== "STREAM_READ_ONLY" && denial.code !== "STREAM_NOT_FOUND") throw error
          const alreadyTerminal = await StreamEventRepository.findCommandTerminal(client, streamId, commandId)
          if (!alreadyTerminal) {
            const reason =
              denial.code === "STREAM_NOT_FOUND" ? "not_a_member" : (denial.details?.reason ?? "not_a_member")
            await insertCommandFailedEvent(client, {
              commandId,
              workspaceId,
              streamId,
              userId,
              error: `STREAM_READ_ONLY:${reason}`,
            })
          }
          return true
        }
      })
      if (denied) return
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
