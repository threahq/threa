import { z } from "zod"
import type { Request, Response } from "express"
import type { Pool } from "pg"
import { serializeBigInt } from "@threa/backend-common"
import { BotInvocationCapabilities, BotInvocationTriggers, BotRuntimeKinds, CommandKinds } from "@threa/types"
import type { BotRuntimeKind } from "@threa/types"
import { withTransaction } from "../../db"
import { commandId as generateCommandId } from "../../lib/id"
import { parseCommand } from "./registry"
import type { CommandAvailabilityService } from "./availability"
import type { BotRuntimeService } from "../bot-runtimes"
import { buildRuntimeCommandInvocationMetadata, insertCommandDispatchedEvent } from "./events"

const dispatchCommandSchema = z.object({
  command: z.string().min(1, "command is required"),
  streamId: z.string().min(1, "streamId is required"),
})

interface Dependencies {
  pool: Pool
  commandAvailabilityService: CommandAvailabilityService
  botRuntimeService: BotRuntimeService
}

export function resolveRuntimeInvocationRouting(
  commandName: string,
  runtimeKind: BotRuntimeKind
): {
  trigger: (typeof BotInvocationTriggers)[keyof typeof BotInvocationTriggers]
  requiredCapability: (typeof BotInvocationCapabilities)[keyof typeof BotInvocationCapabilities]
} {
  if (commandName === "steer" || commandName === "stop" || commandName === "kick" || commandName === "carry-on") {
    // steer/stop/kick/carry-on must reach the runtime mid-turn. Pi advertises
    // `active-scratchpad` while busy, so it claims them there. The Claude Code
    // channel instead advertises ONLY `session-control` while busy (so a normal
    // `active-scratchpad` follow-up stays queued behind the running turn) — route
    // its interrupts there so a busy channel can still claim them. carry-on's
    // whole purpose is a session blocked mid-turn on provider quota, so it takes
    // the same route. See docs/claude-channel-session-control.md.
    return {
      trigger: BotInvocationTriggers.SESSION_CONTROL,
      requiredCapability:
        runtimeKind === BotRuntimeKinds.CLAUDE_CODE_CHANNEL
          ? BotInvocationCapabilities.SESSION_CONTROL
          : BotInvocationCapabilities.ACTIVE_SCRATCHPAD,
    }
  }
  return {
    trigger: BotInvocationTriggers.SESSION_CONTROL,
    requiredCapability: BotInvocationCapabilities.SESSION_CONTROL,
  }
}

export function createCommandHandlers({ pool, commandAvailabilityService, botRuntimeService }: Dependencies) {
  return {
    /**
     * Dispatch a slash command.
     *
     * This validates the command against the stream-effective command list,
     * creates a command_dispatched event, and routes execution to either the
     * server command worker or a targeted bot-runtime invocation.
     */
    async dispatch(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!

      const result = dispatchCommandSchema.safeParse(req.body)
      if (!result.success) {
        return res.status(400).json({
          success: false,
          error: "Validation failed",
          details: z.flattenError(result.error).fieldErrors,
        })
      }

      const { command: commandString, streamId } = result.data
      const parsed = parseCommand(commandString)
      if (!parsed) {
        return res.status(400).json({
          success: false,
          error: "Invalid command format. Commands must start with / followed by a name.",
        })
      }

      const resolved = await commandAvailabilityService.resolveCommand({
        workspaceId,
        userId,
        streamId,
        name: parsed.name,
      })

      if (!resolved) {
        const availableCommands = await commandAvailabilityService.listStreamCommands({ workspaceId, userId, streamId })
        return res.status(404).json({
          success: false,
          error: `Unknown command: ${parsed.name}`,
          availableCommands: availableCommands.map((command) => command.name),
        })
      }

      if (resolved.executionKind === CommandKinds.CLIENT_ACTION) {
        return res.status(400).json({
          success: false,
          error: "Client-action commands cannot be dispatched to the server",
        })
      }

      const cmdId = generateCommandId()

      if (resolved.executionKind === CommandKinds.SERVER) {
        const event = await withTransaction(pool, (client) =>
          insertCommandDispatchedEvent(client, {
            workspaceId,
            streamId,
            userId,
            commandId: cmdId,
            name: parsed.name,
            args: parsed.args,
            executionKind: CommandKinds.SERVER,
          })
        )

        return res.status(202).json({
          success: true,
          commandId: cmdId,
          command: parsed.name,
          args: parsed.args,
          event: serializeBigInt(event),
        })
      }

      const event = await withTransaction(pool, async (client) => {
        const evt = await insertCommandDispatchedEvent(client, {
          workspaceId,
          streamId,
          userId,
          commandId: cmdId,
          name: parsed.name,
          args: parsed.args,
          executionKind: CommandKinds.BOT_RUNTIME,
        })

        const metadata = buildRuntimeCommandInvocationMetadata({
          commandId: cmdId,
          name: parsed.name,
          args: parsed.args,
        })
        const routing = resolveRuntimeInvocationRouting(parsed.name, resolved.runtime.runtimeKind)
        await botRuntimeService.createInvocationInTransaction(client, {
          workspaceId,
          rootStreamId: resolved.runtime.rootStreamId,
          activeStreamId: resolved.runtime.activeStreamId,
          sourceMessageId: cmdId,
          responseStreamId: resolved.runtime.responseStreamId,
          actorId: resolved.runtime.botId,
          trigger: routing.trigger,
          requiredCapability: routing.requiredCapability,
          promptMarkdown: `/${parsed.name}${parsed.args ? ` ${parsed.args}` : ""}`,
          authorUserId: userId,
          targetInstanceId: resolved.runtime.targetInstanceId,
          targetRuntimeSessionId: resolved.runtime.targetRuntimeSessionId,
          metadata,
        })

        return evt
      })

      res.status(202).json({
        success: true,
        commandId: cmdId,
        command: parsed.name,
        args: parsed.args,
        event: serializeBigInt(event),
      })
    },

    /**
     * List workspace-level fallback commands with their metadata.
     */
    list(_req: Request, res: Response) {
      res.json({ commands: commandAvailabilityService.listWorkspaceCommands() })
    },

    /**
     * List the commands available in a specific stream — the workspace set plus
     * any session-control commands the stream's linked runtime advertises. This
     * is what the composer's slash menu renders.
     */
    async listForStream(req: Request, res: Response) {
      const commands = await commandAvailabilityService.listStreamCommands({
        workspaceId: req.workspaceId!,
        userId: req.user!.id,
        streamId: req.params.streamId!,
      })
      res.json({ commands })
    },
  }
}
