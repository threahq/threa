import { z } from "zod"
import type { Request, Response } from "express"
import type { Pool } from "pg"
import { serializeBigInt } from "@threa/backend-common"
import { BotInvocationCapabilities, BotInvocationTriggers, BotRuntimeKinds, CommandKinds } from "@threa/types"
import type { BotRuntimeKind, CommandDispatchedPayload } from "@threa/types"
import { withClient, withTransaction, type Querier } from "../../db"
import { commandId as generateCommandId, eventId as generateEventId } from "../../lib/id"
import { parseCommand } from "./registry"
import type { CommandAvailabilityService } from "./availability"
import type { BotRuntimeService } from "../bot-runtimes"
import { buildRuntimeCommandInvocationMetadata, insertCommandDispatchedEvent } from "./events"
import { CommandDispatchRepository } from "./repository"
import { checkStreamAccess, StreamEventRepository, type StreamEvent } from "../streams"

const dispatchCommandSchema = z.object({
  command: z.string().min(1, "command is required"),
  streamId: z.string().min(1, "streamId is required"),
  clientCommandId: z.string().min(1).max(255).optional(),
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
  if (
    commandName === "steer" ||
    commandName === "stop" ||
    commandName === "kick" ||
    commandName === "carry-on" ||
    commandName === "reconnect"
  ) {
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

interface ClaimedCommandDispatch {
  commandId: string
  command: string
  args: string
  event: StreamEvent
}

async function findCommandDispatchReplay(
  db: Querier,
  params: { workspaceId: string; userId: string; streamId: string; clientCommandId: string }
): Promise<ClaimedCommandDispatch | null> {
  const existing = await CommandDispatchRepository.findByClientId(db, params)
  if (!existing) return null
  const event = await StreamEventRepository.findById(db, existing.eventId)
  if (!event) throw new Error("Command dispatch event missing after idempotency lookup")
  const payload = event.payload as CommandDispatchedPayload
  return { commandId: existing.commandId, command: payload.name, args: payload.args, event }
}

async function claimOrReplayCommandDispatch(
  db: Querier,
  params: {
    workspaceId: string
    userId: string
    streamId: string
    clientCommandId?: string
    commandId: string
    eventId: string
  }
): Promise<ClaimedCommandDispatch | null> {
  if (!params.clientCommandId) return null

  const claimed = await CommandDispatchRepository.claim(db, {
    commandId: params.commandId,
    workspaceId: params.workspaceId,
    userId: params.userId,
    streamId: params.streamId,
    clientCommandId: params.clientCommandId,
    eventId: params.eventId,
  })
  if (claimed) return null

  const replay = await findCommandDispatchReplay(db, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    streamId: params.streamId,
    clientCommandId: params.clientCommandId,
  })
  if (!replay) throw new Error("Command dispatch idempotency row missing after conflict")
  return replay
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

      const { command: commandString, streamId, clientCommandId } = result.data
      const parsed = parseCommand(commandString)
      if (!parsed) {
        return res.status(400).json({
          success: false,
          error: "Invalid command format. Commands must start with / followed by a name.",
        })
      }

      if (clientCommandId) {
        const replayCheck = await withClient(pool, async (client) => {
          const accessible = (await checkStreamAccess(client, streamId, workspaceId, userId)) != null
          return {
            accessible,
            replay: accessible
              ? await findCommandDispatchReplay(client, { workspaceId, userId, streamId, clientCommandId })
              : null,
          }
        })
        if (!replayCheck.accessible) {
          return res.status(404).json({ success: false, error: "Stream not found" })
        }
        if (replayCheck.replay) {
          return res.status(202).json({
            success: true,
            ...replayCheck.replay,
            event: serializeBigInt(replayCheck.replay.event),
          })
        }
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
      const evtId = generateEventId()

      if (resolved.executionKind === CommandKinds.SERVER) {
        const dispatch = await withTransaction(pool, async (client) => {
          const replay = await claimOrReplayCommandDispatch(client, {
            workspaceId,
            userId,
            streamId,
            clientCommandId,
            commandId: cmdId,
            eventId: evtId,
          })
          if (replay) return replay

          const event = await insertCommandDispatchedEvent(client, {
            workspaceId,
            streamId,
            userId,
            commandId: cmdId,
            clientCommandId,
            eventId: evtId,
            name: parsed.name,
            args: parsed.args,
            executionKind: CommandKinds.SERVER,
          })
          return { commandId: cmdId, command: parsed.name, args: parsed.args, event }
        })

        return res.status(202).json({
          success: true,
          ...dispatch,
          event: serializeBigInt(dispatch.event),
        })
      }

      const dispatch = await withTransaction(pool, async (client) => {
        const replay = await claimOrReplayCommandDispatch(client, {
          workspaceId,
          userId,
          streamId,
          clientCommandId,
          commandId: cmdId,
          eventId: evtId,
        })
        if (replay) return replay

        const event = await insertCommandDispatchedEvent(client, {
          workspaceId,
          streamId,
          userId,
          commandId: cmdId,
          clientCommandId,
          eventId: evtId,
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

        return { commandId: cmdId, command: parsed.name, args: parsed.args, event }
      })

      res.status(202).json({
        success: true,
        ...dispatch,
        event: serializeBigInt(dispatch.event),
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
