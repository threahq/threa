import type { Pool } from "pg"
import {
  BotInvocationCapabilities,
  BotRuntimeKinds,
  BotRuntimeStatuses,
  CommandKinds,
  DISCUSS_WITH_ARIADNE_COMMAND,
  StreamTypes,
  botHasCapability,
  type CommandInfo,
} from "@threa/types"
import { withClient, type Querier } from "../../db"
import { checkStreamAccess, StreamRepository, type Stream } from "../streams"
import { BotRepository } from "../public-api"
import {
  BotRuntimeInstanceRepository,
  BotRuntimeSessionLinkRepository,
  StreamActiveActorRepository,
  type BotRuntimeInstance,
  type BotRuntimeSessionLink,
} from "../bot-runtimes"
import type { CommandRegistry } from "./registry"
import {
  listClientActionCommandInfos,
  listPiSessionControlCommandInfos,
  listServerCommandInfos,
  listWorkspaceCommandInfos,
  PI_SESSION_CONTROL_COMMAND_NAMES,
} from "./catalog"

export type ResolvedCommand =
  | { info: CommandInfo; executionKind: "server" }
  | { info: CommandInfo; executionKind: "client-action" }
  | { info: CommandInfo; executionKind: "bot-runtime"; runtime: PiRuntimeCommandTarget }

export interface PiRuntimeCommandTarget {
  botId: string
  rootStreamId: string
  activeStreamId: string
  responseStreamId: string
  targetInstanceId: string
  targetRuntimeSessionId: string
  /** Lowercased canonical names the runtime currently advertises. */
  advertisedCommandNames: ReadonlySet<string>
}

interface PiRuntimeTargetInternal extends PiRuntimeCommandTarget {
  link: BotRuntimeSessionLink
  presence: BotRuntimeInstance
}

export class CommandAvailabilityService {
  constructor(private readonly deps: { pool: Pool; commandRegistry: CommandRegistry }) {}

  listWorkspaceCommands(): CommandInfo[] {
    return listWorkspaceCommandInfos(this.deps.commandRegistry)
  }

  async listStreamCommands(params: { workspaceId: string; userId: string; streamId: string }): Promise<CommandInfo[]> {
    const resolved = await this.resolveStreamCommands(params)
    return resolved.map((command) => command.info)
  }

  async resolveCommand(params: {
    workspaceId: string
    userId: string
    streamId: string
    name: string
  }): Promise<ResolvedCommand | null> {
    const commands = await this.resolveStreamCommands(params)
    const lower = params.name.toLowerCase()
    return commands.find((command) => command.info.name.toLowerCase() === lower) ?? null
  }

  private async resolveStreamCommands(params: {
    workspaceId: string
    userId: string
    streamId: string
  }): Promise<ResolvedCommand[]> {
    return withClient(this.deps.pool, async (client) => {
      const stream = await checkStreamAccess(client, params.streamId, params.workspaceId, params.userId)
      if (!stream || stream.archivedAt) return []

      const commands: ResolvedCommand[] = []

      for (const info of listServerCommandInfos(this.deps.commandRegistry)) {
        if (await isServerCommandAvailableInStream(info.name, stream, client)) {
          commands.push({ info, executionKind: CommandKinds.SERVER })
        }
      }

      for (const info of listClientActionCommandInfos()) {
        if (isClientActionAvailableInStream(info, stream)) {
          commands.push({ info, executionKind: CommandKinds.CLIENT_ACTION })
        }
      }

      const runtimeTarget = await resolvePiRuntimeCommandTarget(client, {
        workspaceId: params.workspaceId,
        userId: params.userId,
        stream,
      })
      if (runtimeTarget) {
        for (const info of listPiSessionControlCommandInfos()) {
          if (!runtimeTarget.advertisedCommandNames.has(info.name.toLowerCase())) continue
          commands.push({ info, executionKind: CommandKinds.BOT_RUNTIME, runtime: runtimeTarget })
        }
      }

      return dedupeCommands(commands)
    })
  }
}

async function isServerCommandAvailableInStream(name: string, stream: Stream, db: Querier): Promise<boolean> {
  if (name !== "invite") return true
  if (stream.type === StreamTypes.CHANNEL) return true
  if (stream.type !== StreamTypes.THREAD || !stream.rootStreamId) return false
  const root = await StreamRepository.findById(db, stream.rootStreamId)
  return root?.type === StreamTypes.CHANNEL
}

function isClientActionAvailableInStream(info: CommandInfo, stream: Stream): boolean {
  if (info.clientActionId === DISCUSS_WITH_ARIADNE_COMMAND) return !!stream.id
  return true
}

async function resolvePiRuntimeCommandTarget(
  db: Querier,
  params: { workspaceId: string; userId: string; stream: Stream }
): Promise<PiRuntimeTargetInternal | null> {
  const { workspaceId, stream } = params
  const rootStreamId = stream.rootStreamId ?? stream.id
  const rootStream = rootStreamId === stream.id ? stream : await StreamRepository.findById(db, rootStreamId)

  if (!rootStream || rootStream.workspaceId !== workspaceId) return null
  if (rootStream.archivedAt) return null
  if (rootStream.type !== StreamTypes.SCRATCHPAD) return null

  const active = await StreamActiveActorRepository.findByRootStream(db, workspaceId, rootStream.id)
  if (!active || active.actorType !== "bot") return null

  const bot = await BotRepository.findById(db, workspaceId, active.actorId)
  if (!bot || bot.archivedAt) return null
  if (!botHasCapability(bot, BotInvocationCapabilities.ACTIVE_SCRATCHPAD)) return null

  let link = await BotRuntimeSessionLinkRepository.findActiveByStream(db, {
    workspaceId,
    botId: bot.id,
    rootStreamId: rootStream.id,
    activeStreamId: stream.id,
  })
  if (!link && stream.id !== rootStream.id) {
    link = await BotRuntimeSessionLinkRepository.findActiveByStream(db, {
      workspaceId,
      botId: bot.id,
      rootStreamId: rootStream.id,
      activeStreamId: rootStream.id,
    })
  }
  if (!link) return null

  const presence = await BotRuntimeInstanceRepository.findByInstance(db, {
    workspaceId,
    botId: bot.id,
    instanceId: link.instanceId,
  })
  if (!presence) return null
  if (presence.runtimeKind !== BotRuntimeKinds.PI_LOCAL) return null
  if (presence.status !== BotRuntimeStatuses.AVAILABLE && presence.status !== BotRuntimeStatuses.BUSY) return null

  const runtimeSessionId =
    typeof presence.capabilities.runtimeSessionId === "string" ? presence.capabilities.runtimeSessionId : null
  if (runtimeSessionId !== link.runtimeSessionId) return null

  const advertisedCommandNames = resolveAdvertisedSessionControlCommandNames(presence)
  if (advertisedCommandNames.size === 0) return null

  return {
    botId: bot.id,
    rootStreamId: rootStream.id,
    activeStreamId: stream.id,
    responseStreamId: stream.id,
    targetInstanceId: link.instanceId,
    targetRuntimeSessionId: link.runtimeSessionId,
    advertisedCommandNames,
    link,
    presence,
  }
}

/**
 * Lowercased intersection of the canonical Pi session-control commands with
 * what the runtime currently advertises. Empty set means "not supported".
 * Returning the intersection (instead of a plain boolean) lets the caller
 * surface exactly the commands the runtime can actually handle.
 */
function resolveAdvertisedSessionControlCommandNames(presence: BotRuntimeInstance): ReadonlySet<string> {
  if (presence.capabilities.supportsSessionControlCommands !== true) return new Set()
  const advertised = presence.capabilities.sessionControlCommands
  if (!Array.isArray(advertised)) return new Set()
  const advertisedLower = new Set(
    advertised.filter((value): value is string => typeof value === "string").map((value) => value.toLowerCase())
  )
  return new Set(PI_SESSION_CONTROL_COMMAND_NAMES.filter((name) => advertisedLower.has(name.toLowerCase())))
}

function dedupeCommands(commands: ResolvedCommand[]): ResolvedCommand[] {
  const byName = new Map<string, ResolvedCommand>()
  for (const command of commands) {
    byName.set(command.info.name.toLowerCase(), command)
  }
  return Array.from(byName.values())
}
