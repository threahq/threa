import { z } from "zod"
import type { Request, Response } from "express"
import type { Pool } from "pg"
import { serializeBigInt } from "@threa/backend-common"
import { BotInvocationCapabilities, BotInvocationTriggers, BotRuntimeKinds, CommandKinds } from "@threa/types"
import type { BotRuntimeKind, CommandDispatchedPayload } from "@threa/types"
import { withClient, withTransaction, type Querier } from "../../db"
import { commandId as generateCommandId, eventId as generateEventId } from "../../lib/id"
import { HttpError } from "../../lib/errors"
import { parseCommand } from "./registry"
import { commandRequiresWritableAuthority, type CommandAvailabilityService } from "./availability"
import type { BotRuntimeService } from "../bot-runtimes"
import { buildRuntimeCommandInvocationMetadata, insertCommandDispatchedEvent } from "./events"
import { CommandDispatchRepository } from "./repository"
import {
  assertViewerStreamWritable,
  resolveLockedStreamAuthorities,
  StreamEventRepository,
  type StreamEvent,
} from "../streams"

const dispatchCommandSchema = z.object({
  command: z.string().min(1, "command is required"),
  streamId: z.string().min(1, "streamId is required"),
  clientCommandId: z.string().min(1).max(255).optional(),
  conversationId: z.string().min(1).optional(),
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
    ((commandName === "reconnect" || commandName === "clear" || commandName === "key") &&
      runtimeKind === BotRuntimeKinds.PI_LOCAL)
  ) {
    // Pi advertises `active-scratchpad` while busy. Every other linkable
    // runtime (the Claude Code channel, SDK-built `custom` runtimes) advertises
    // only `session-control` while busy, so its interrupts route there.
    return {
      trigger: BotInvocationTriggers.SESSION_CONTROL,
      requiredCapability:
        runtimeKind === BotRuntimeKinds.PI_LOCAL
          ? BotInvocationCapabilities.ACTIVE_SCRATCHPAD
          : BotInvocationCapabilities.SESSION_CONTROL,
    }
  }
  if (commandName === "reconnect" && runtimeKind === BotRuntimeKinds.CLAUDE_CODE_CHANNEL) {
    return {
      trigger: BotInvocationTriggers.SESSION_CONTROL,
      requiredCapability: BotInvocationCapabilities.SESSION_CONTROL,
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

      const { command: commandString, streamId, clientCommandId, conversationId } = result.data
      const parsed = parseCommand(commandString)
      if (!parsed) {
        return res.status(400).json({
          success: false,
          error: "Invalid command format. Commands must start with / followed by a name.",
        })
      }

      if (clientCommandId) {
        const replay = await withTransaction(pool, async (client) => {
          await resolveLockedStreamAuthorities(client, {
            workspaceId,
            streamIds: [streamId],
            principal: { kind: "user", userId },
          })
          return findCommandDispatchReplay(client, { workspaceId, userId, streamId, clientCommandId })
        })
        if (replay) {
          return res.status(202).json({
            success: true,
            ...replay,
            event: serializeBigInt(replay.event),
          })
        }
      }

      const resolved = await commandAvailabilityService.resolveCommandForDispatch({
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
          const [authority] = await resolveLockedStreamAuthorities(client, {
            workspaceId,
            streamIds: [streamId],
            principal: { kind: "user", userId },
          })
          const committedReplay = clientCommandId
            ? await findCommandDispatchReplay(client, { workspaceId, userId, streamId, clientCommandId })
            : null
          if (committedReplay) return committedReplay
          if (commandRequiresWritableAuthority(parsed.name)) assertViewerStreamWritable(authority.state)

          const replay = await claimOrReplayCommandDispatch(client, {
            workspaceId,
            userId,
            streamId,
            clientCommandId,
            commandId: cmdId,
            eventId: evtId,
          })
          if (replay) return replay

          const current = await commandAvailabilityService.resolveCommandInTransaction(
            client,
            {
              workspaceId,
              userId,
              streamId,
              name: parsed.name,
            },
            { includeReadOnlyWorkCommands: true }
          )
          if (!current || current.executionKind !== CommandKinds.SERVER) {
            throw new HttpError("Command is no longer available", { status: 404, code: "COMMAND_NOT_AVAILABLE" })
          }

          const event = await insertCommandDispatchedEvent(client, {
            workspaceId,
            streamId,
            userId,
            commandId: cmdId,
            clientCommandId,
            eventId: evtId,
            name: parsed.name,
            args: parsed.args,
            conversationId,
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
        const [authority] = await resolveLockedStreamAuthorities(client, {
          workspaceId,
          streamIds: [streamId],
          principal: { kind: "user", userId },
        })
        const committedReplay = clientCommandId
          ? await findCommandDispatchReplay(client, { workspaceId, userId, streamId, clientCommandId })
          : null
        if (committedReplay) return committedReplay
        if (commandRequiresWritableAuthority(parsed.name)) assertViewerStreamWritable(authority.state)

        const replay = await claimOrReplayCommandDispatch(client, {
          workspaceId,
          userId,
          streamId,
          clientCommandId,
          commandId: cmdId,
          eventId: evtId,
        })
        if (replay) return replay

        const current = await commandAvailabilityService.resolveCommandInTransaction(
          client,
          {
            workspaceId,
            userId,
            streamId,
            name: parsed.name,
          },
          { includeReadOnlyWorkCommands: true }
        )
        if (!current || current.executionKind !== CommandKinds.BOT_RUNTIME) {
          throw new HttpError("Command is no longer available", { status: 404, code: "COMMAND_NOT_AVAILABLE" })
        }

        const event = await insertCommandDispatchedEvent(client, {
          workspaceId,
          streamId,
          userId,
          commandId: cmdId,
          clientCommandId,
          eventId: evtId,
          name: parsed.name,
          args: parsed.args,
          conversationId,
          executionKind: CommandKinds.BOT_RUNTIME,
        })

        const metadata = buildRuntimeCommandInvocationMetadata({
          commandId: cmdId,
          name: parsed.name,
          args: parsed.args,
        })
        const routing = resolveRuntimeInvocationRouting(parsed.name, current.runtime.runtimeKind)
        await botRuntimeService.createInvocationInTransaction(client, {
          workspaceId,
          rootStreamId: current.runtime.rootStreamId,
          activeStreamId: current.runtime.activeStreamId,
          sourceMessageId: cmdId,
          responseStreamId: current.runtime.responseStreamId,
          actorId: current.runtime.botId,
          trigger: routing.trigger,
          requiredCapability: routing.requiredCapability,
          promptMarkdown: `/${parsed.name}${parsed.args ? ` ${parsed.args}` : ""}`,
          authorUserId: userId,
          targetInstanceId: current.runtime.targetInstanceId,
          targetRuntimeSessionId: current.runtime.targetRuntimeSessionId,
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
