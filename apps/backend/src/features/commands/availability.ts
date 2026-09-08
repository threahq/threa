import type { Pool } from "pg"
import {
  BotInvocationCapabilities,
  BotRuntimeKinds,
  BotRuntimeStatuses,
  BotTypes,
  ASIDE_COMMAND,
  CommandKinds,
  StreamTypes,
  botHasCapability,
  isAsideHostType,
  type BotRuntimeKind,
  type CommandArgumentInfo,
  type CommandArgumentSuggestion,
  type CommandInfo,
} from "@threahq/types"
import { withClient, type Querier } from "../../db"
import { checkStreamAccess, projectStreamForUser, StreamRepository, type Stream } from "../streams"
import { BotRepository } from "../public-api"
import {
  BotRuntimeInstanceRepository,
  type BotRuntimeInstance,
  type BotRuntimeSessionLink,
  resolveLinkedRuntimeRouteTarget,
  resolveRuntimeKindConfig,
} from "../bot-runtimes"
import type { CommandRegistry } from "./registry"
import {
  listClientActionCommandInfos,
  listSessionControlCommandInfos,
  listServerCommandInfos,
  listWorkspaceCommandInfos,
  SESSION_CONTROL_COMMAND_NAMES,
  SPAWN_MODEL_ARG,
  SPAWN_THINKING_ARG,
} from "./catalog"

const READ_ONLY_COMMAND_NAMES = new Set(["invite", "stop", "status"])

export function commandRequiresWritableAuthority(name: string): boolean {
  return !READ_ONLY_COMMAND_NAMES.has(name.toLowerCase())
}

export type ResolvedCommand =
  | { info: CommandInfo; executionKind: "server" }
  | { info: CommandInfo; executionKind: "client-action" }
  | { info: CommandInfo; executionKind: "bot-runtime"; runtime: RuntimeCommandTarget }

export interface RuntimeCommandTarget {
  botId: string
  /** The live runtime's kind — drives kind-specific invocation routing (e.g. steer/stop capability). */
  runtimeKind: BotRuntimeKind
  rootStreamId: string
  activeStreamId: string
  responseStreamId: string
  targetInstanceId: string
  targetRuntimeSessionId: string
  /** Whether this user may invoke the target through mention routing for dedupe. */
  supportsMentionable: boolean
  /** Lowercased canonical names the runtime currently advertises. */
  advertisedCommandNames: ReadonlySet<string>
  /** Thinking levels the runtime supports for the current model. Empty = runtime did not advertise. */
  advertisedThinkingLevels: readonly string[]
  /** Model suggestions the runtime advertises for autocomplete. Empty = runtime did not advertise. */
  advertisedModelSuggestions: readonly CommandArgumentSuggestion[]
  /** Runtimes the linked session can hand `/spawn` off to, each carrying its own models and levels. */
  advertisedSpawnRuntimes: readonly CommandArgumentSuggestion[]
  /** The runtime a `/spawn` that names none lands on, so its lists are the ones offered up front. */
  advertisedSpawnDefault: string | null
}

interface RuntimeTargetInternal extends RuntimeCommandTarget {
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
    return withClient(this.deps.pool, (db) => this.resolveCommandInTransaction(db, params))
  }

  async resolveCommandInTransaction(
    db: Querier,
    params: { workspaceId: string; userId: string; streamId: string; name: string },
    options?: { includeReadOnlyWorkCommands?: boolean }
  ): Promise<ResolvedCommand | null> {
    const commands = await this.resolveStreamCommandsInTransaction(db, params, options)
    const lower = params.name.toLowerCase()
    return commands.find((command) => command.info.name.toLowerCase() === lower) ?? null
  }

  async resolveCommandForDispatch(params: {
    workspaceId: string
    userId: string
    streamId: string
    name: string
  }): Promise<ResolvedCommand | null> {
    return withClient(this.deps.pool, (db) =>
      this.resolveCommandInTransaction(db, params, { includeReadOnlyWorkCommands: true })
    )
  }

  private async resolveStreamCommands(params: {
    workspaceId: string
    userId: string
    streamId: string
  }): Promise<ResolvedCommand[]> {
    return withClient(this.deps.pool, (db) => this.resolveStreamCommandsInTransaction(db, params))
  }

  private async resolveStreamCommandsInTransaction(
    db: Querier,
    params: { workspaceId: string; userId: string; streamId: string },
    options?: { includeReadOnlyWorkCommands?: boolean }
  ): Promise<ResolvedCommand[]> {
    const stream = await checkStreamAccess(db, params.streamId, params.workspaceId, params.userId)
    if (!stream) return []
    const projected = await projectStreamForUser(db, {
      workspaceId: params.workspaceId,
      stream,
      userId: params.userId,
    })
    if (!projected) return []
    const writable = !projected.readOnly

    const commands: ResolvedCommand[] = []

    for (const info of listServerCommandInfos(this.deps.commandRegistry)) {
      if (
        (options?.includeReadOnlyWorkCommands || writable || !commandRequiresWritableAuthority(info.name)) &&
        (await isServerCommandAvailableInStream(info.name, stream, db))
      ) {
        commands.push({ info, executionKind: CommandKinds.SERVER })
      }
    }

    for (const info of listClientActionCommandInfos()) {
      if (isClientActionAvailableInStream(info, stream, { writable })) {
        commands.push({ info, executionKind: CommandKinds.CLIENT_ACTION })
      }
    }

    const runtimeTarget = await resolveRuntimeCommandTarget(db, {
      workspaceId: params.workspaceId,
      userId: params.userId,
      stream,
    })
    if (runtimeTarget) {
      for (const info of listSessionControlCommandInfos()) {
        if (!runtimeTarget.advertisedCommandNames.has(info.name.toLowerCase())) continue
        if (!options?.includeReadOnlyWorkCommands && !writable && commandRequiresWritableAuthority(info.name)) continue
        commands.push({
          info: applyAdvertisedSuggestions(info, runtimeTarget),
          executionKind: CommandKinds.BOT_RUNTIME,
          runtime: runtimeTarget,
        })
      }
    }

    return dedupeCommands(commands)
  }
}

async function isServerCommandAvailableInStream(name: string, stream: Stream, db: Querier): Promise<boolean> {
  if (name !== "invite") return true
  if (stream.type === StreamTypes.CHANNEL) return true
  if (stream.type !== StreamTypes.THREAD || !stream.rootStreamId) return false
  const root = await StreamRepository.findById(db, stream.rootStreamId)
  return root?.type === StreamTypes.CHANNEL
}

/**
 * Client-action commands are gated per host stream. `/aside` follows the create
 * path's own rules (host type, no E2E host, writable host) so the palette never
 * offers an aside the server would refuse — and never inside an aside.
 */
export function isClientActionAvailableInStream(
  info: CommandInfo,
  stream: Stream,
  options?: { writable?: boolean }
): boolean {
  if (info.clientActionId === ASIDE_COMMAND) {
    // An aside inherits its host's archive state, so an archived (read-only)
    // host cannot open one — the create path refuses it.
    return isAsideHostType(stream.type) && stream.e2eEnabled !== true && options?.writable !== false
  }
  return true
}

async function resolveRuntimeCommandTarget(
  db: Querier,
  params: { workspaceId: string; userId: string; stream: Stream }
): Promise<RuntimeTargetInternal | null> {
  const { workspaceId, stream } = params
  const rootStreamId = stream.rootStreamId ?? stream.id
  const rootStream = rootStreamId === stream.id ? stream : await StreamRepository.findById(db, rootStreamId)

  if (!rootStream || rootStream.workspaceId !== workspaceId) return null
  if (rootStream.type !== StreamTypes.SCRATCHPAD) return null

  const routeTarget = await resolveLinkedRuntimeRouteTarget(db, {
    workspaceId,
    rootStreamId: rootStream.id,
    activeStreamId: stream.id,
  })
  if (!routeTarget?.link) return null

  const bot = await BotRepository.findById(db, workspaceId, routeTarget.botId)
  if (!bot || bot.archivedAt) return null
  if (!botHasCapability(bot, BotInvocationCapabilities.ACTIVE_SCRATCHPAD)) return null

  const link = routeTarget.link
  const presence = await BotRuntimeInstanceRepository.findByInstance(db, {
    workspaceId,
    botId: bot.id,
    instanceId: link.instanceId,
  })
  if (!presence) return null
  // Session-control is for runtimes that drive a long-lived linked session
  // (Pi natively, the Claude Code channel via tmux, an SDK-built custom
  // runtime through its actuator). Each gates the surfaced command set on what
  // it advertises in `sessionControlCommands`.
  if (resolveRuntimeKindConfig(presence.runtimeKind).sessionLinking === "none") return null
  if (presence.status !== BotRuntimeStatuses.AVAILABLE && presence.status !== BotRuntimeStatuses.BUSY) return null

  const runtimeSessionId =
    typeof presence.capabilities.runtimeSessionId === "string" ? presence.capabilities.runtimeSessionId : null
  if (runtimeSessionId !== link.runtimeSessionId) return null

  const advertisedCommandNames = resolveAdvertisedSessionControlCommandNames(presence)
  if (advertisedCommandNames.size === 0) return null

  return {
    botId: bot.id,
    runtimeKind: presence.runtimeKind,
    rootStreamId: rootStream.id,
    activeStreamId: stream.id,
    responseStreamId: stream.id,
    targetInstanceId: link.instanceId,
    targetRuntimeSessionId: link.runtimeSessionId,
    // Mirror BotRepository.findInvocableByIds: the composite must choose the
    // same trigger as the later message outbox so their idempotency keys match.
    supportsMentionable:
      botHasCapability(bot, BotInvocationCapabilities.MENTIONABLE) &&
      (bot.type === BotTypes.SHARED || bot.ownerUserId === params.userId),
    advertisedCommandNames,
    advertisedThinkingLevels: toStrings(presence.capabilities.thinkingLevels),
    advertisedModelSuggestions: toSuggestions(presence.capabilities.modelSuggestions),
    advertisedSpawnRuntimes: resolveAdvertisedSpawnRuntimes(presence),
    advertisedSpawnDefault:
      typeof presence.capabilities.spawnDefaultRuntime === "string" ? presence.capabilities.spawnDefaultRuntime : null,
    link,
    presence,
  }
}

/** A capability array is whatever the runtime sent; anything that isn't a string is dropped. */
function toStrings(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((value): value is string => typeof value === "string") : []
}

function toSuggestions(raw: unknown): CommandArgumentSuggestion[] {
  if (!Array.isArray(raw)) return []
  return raw.map(toSuggestion).filter((one): one is CommandArgumentSuggestion => one !== null)
}

function toSuggestion(entry: unknown): CommandArgumentSuggestion | null {
  if (!entry || typeof entry !== "object") return null
  const candidate = entry as Record<string, unknown>
  if (typeof candidate.value !== "string") return null
  const suggestion: CommandArgumentSuggestion = { value: candidate.value }
  if (typeof candidate.label === "string") suggestion.label = candidate.label
  if (typeof candidate.description === "string") suggestion.description = candidate.description
  return suggestion
}

/**
 * A spawn runtime carries the models and thinking levels of ITS binary, read on
 * the runtime's machine — a Claude desk spawning Pi offers Pi's list. They ride
 * along as the suggestion's own args so the picker can switch lists when the
 * typed runtime changes.
 */
function resolveAdvertisedSpawnRuntimes(presence: BotRuntimeInstance): readonly CommandArgumentSuggestion[] {
  const raw = presence.capabilities.spawnRuntimes
  if (!Array.isArray(raw)) return []
  const result: CommandArgumentSuggestion[] = []
  for (const entry of raw) {
    const suggestion = toSuggestion(entry)
    if (!suggestion) continue
    const args = spawnOverrideArgs(entry as Record<string, unknown>)
    result.push(args.length > 0 ? { ...suggestion, args } : suggestion)
  }
  return result
}

function spawnOverrideArgs(candidate: Record<string, unknown>): CommandArgumentInfo[] {
  const args: CommandArgumentInfo[] = []
  const models = toSuggestions(candidate.models)
  if (models.length > 0) args.push({ name: SPAWN_MODEL_ARG, suggestions: models })
  const levels = toStrings(candidate.thinkingLevels)
  if (levels.length > 0) args.push({ name: SPAWN_THINKING_ARG, suggestions: levels.map((value) => ({ value })) })
  return args
}

function applyAdvertisedSuggestions(info: CommandInfo, target: RuntimeCommandTarget): CommandInfo {
  if (info.name === "thinking" && target.advertisedThinkingLevels.length > 0) {
    return withArgSuggestions(
      info,
      "level",
      target.advertisedThinkingLevels.map((value) => ({ value }))
    )
  }
  if (info.name === "model" && target.advertisedModelSuggestions.length > 0) {
    return withArgSuggestions(info, "model", target.advertisedModelSuggestions)
  }
  if (info.name === "spawn" && target.advertisedSpawnRuntimes.length > 0) {
    const withRuntimes = withArgSuggestions(info, "runtime", target.advertisedSpawnRuntimes)
    // The overrides start out on the runtime a bare `/spawn` lands on; naming a
    // runtime swaps in that suggestion's own args.
    const fallback = target.advertisedSpawnRuntimes.find((one) => one.value === target.advertisedSpawnDefault)
    return (fallback?.args ?? []).reduce(
      (carried, arg) => withArgSuggestions(carried, arg.name, arg.suggestions ?? []),
      withRuntimes
    )
  }
  return info
}

function withArgSuggestions(
  info: CommandInfo,
  argName: string,
  suggestions: readonly CommandArgumentSuggestion[]
): CommandInfo {
  if (!info.args) return info
  return {
    ...info,
    args: info.args.map((arg) => (arg.name === argName ? { ...arg, suggestions: [...suggestions] } : arg)),
  }
}

/**
 * Lowercased intersection of the canonical Pi session-control commands with
 * what the runtime currently advertises. Empty set means "not supported".
 * Returning the intersection (instead of a plain boolean) lets the caller
 * surface exactly the commands the runtime can actually handle.
 */
export function resolveAdvertisedSessionControlCommandNames(presence: BotRuntimeInstance): ReadonlySet<string> {
  if (presence.capabilities.supportsSessionControlCommands !== true) return new Set()
  const advertised = presence.capabilities.sessionControlCommands
  if (!Array.isArray(advertised)) return new Set()
  const advertisedLower = new Set(
    advertised.filter((value): value is string => typeof value === "string").map((value) => value.toLowerCase())
  )
  return new Set(SESSION_CONTROL_COMMAND_NAMES.filter((name) => advertisedLower.has(name.toLowerCase())))
}

function dedupeCommands(commands: ResolvedCommand[]): ResolvedCommand[] {
  const byName = new Map<string, ResolvedCommand>()
  for (const command of commands) {
    byName.set(command.info.name.toLowerCase(), command)
  }
  return Array.from(byName.values())
}
