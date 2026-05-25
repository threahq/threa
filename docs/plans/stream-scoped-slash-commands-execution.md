# Stream-scoped slash commands — execution handoff plan

This is the low-thinking implementation plan for `plan/stream-scoped-slash-commands`.

Read this alongside the high-level plan in:

- `docs/plans/stream-scoped-slash-commands.md`

## Implementation target

Implement stream-effective slash commands for linked Pi remote scratchpads and scratchpad-rooted threads.

Initial commands:

- `/compact [instructions]`
- `/model <model>`
- `/thinking <off|minimal|low|medium|high|xhigh>`
- `/skill <query>`

Important detail: `StreamBootstrap.commands` should be the **complete effective command list for that stream**, not just dynamic additions. That lets the backend own availability for both existing global commands like `/invite` and new runtime-scoped commands. Workspace bootstrap keeps returning workspace-level fallback commands for places where no stream is active.

## Implementation order

Do the work in this order:

1. Shared types/constants.
2. Backend command catalog + availability resolver.
3. Stream bootstrap listing.
4. Runtime command dispatch + bot invocation metadata.
5. Runtime invocation completion/failure -> command lifecycle events.
6. Frontend effective command list from stream bootstrap.
7. Pi adapter capability advertisement + local execution.
8. Tests.

Do not add a database table for dynamic commands in this pass.

---

## 1. Shared types/constants

### File: `packages/types/src/api.ts`

Extend command metadata.

Current:

```ts
export const CommandKinds = {
  SERVER: "server",
  CLIENT_ACTION: "client-action",
} as const
```

Change to:

```ts
export const CommandKinds = {
  SERVER: "server",
  CLIENT_ACTION: "client-action",
  BOT_RUNTIME: "bot-runtime",
} as const
export type CommandKind = (typeof CommandKinds)[keyof typeof CommandKinds]

export const CommandScopes = {
  WORKSPACE: "workspace",
  STREAM: "stream",
} as const
export type CommandScope = (typeof CommandScopes)[keyof typeof CommandScopes]

export interface CommandArgumentSuggestion {
  value: string
  label?: string
  description?: string
}

export interface CommandArgumentInfo {
  name: string
  required?: boolean
  description?: string
  suggestions?: CommandArgumentSuggestion[]
}
```

Extend `CommandInfo`:

```ts
export interface CommandInfo {
  name: string
  description: string
  /** Omitted for backwards compat = "server". */
  kind?: CommandKind
  /** Workspace commands are globally known; stream commands depend on active stream context. */
  scope?: CommandScope
  /** For `kind: "client-action"`, the stable id the frontend dispatches on. */
  clientActionId?: string
  /** Optional first-pass argument metadata. UI can ignore this until argument autocomplete exists. */
  args?: CommandArgumentInfo[]
}
```

Add command info to stream bootstrap. Prefer optional for cached/older bootstraps:

```ts
export interface StreamBootstrap {
  // existing fields...
  /** Complete slash-command list effective for this stream. Live backend returns this. */
  commands?: CommandInfo[]
}
```

Extend command lifecycle payloads:

```ts
export interface CommandDispatchedPayload {
  commandId: string
  name: string
  args: string
  status: "dispatched"
  /** Missing means legacy server command. */
  executionKind?: Extract<CommandKind, "server" | "bot-runtime">
}
```

No change required to `DispatchCommandInput` or `DispatchCommandResponse`.

### File: `packages/types/src/constants.ts`

Add a bot invocation capability and trigger.

Current:

```ts
export const BOT_INVOCATION_TRIGGERS = ["mention", "active-scratchpad"] as const
export const BOT_INVOCATION_CAPABILITIES = ["mentionable", "active-scratchpad"] as const
```

Change to:

```ts
export const BOT_INVOCATION_TRIGGERS = ["mention", "active-scratchpad", "session-control"] as const

export const BotInvocationTriggers = {
  MENTION: "mention",
  ACTIVE_SCRATCHPAD: "active-scratchpad",
  SESSION_CONTROL: "session-control",
} as const satisfies Record<string, BotInvocationTrigger>

export const BOT_INVOCATION_CAPABILITIES = ["mentionable", "active-scratchpad", "session-control"] as const

export const BotInvocationCapabilities = {
  MENTIONABLE: "mentionable",
  ACTIVE_SCRATCHPAD: "active-scratchpad",
  SESSION_CONTROL: "session-control",
} as const satisfies Record<string, BotInvocationCapability>
```

No DB migration is needed; these are `TEXT` columns validated in app code.

### File: `packages/types/src/index.ts`

Export any new command types/constants:

```ts
CommandScope,
CommandArgumentInfo,
CommandArgumentSuggestion,
```

and:

```ts
export { CommandKinds, CommandScopes } from "./api"
```

---

## 2. Backend command catalog + availability resolver

### New file: `apps/backend/src/features/commands/catalog.ts`

Purpose: central source for built-in command descriptors and Pi runtime command descriptors. This removes current duplication between workspace bootstrap and frontend ad hoc filtering.

Add:

```ts
import { CommandKinds, CommandScopes, DISCUSS_WITH_ARIADNE_COMMAND, type CommandInfo } from "@threa/types"
import type { CommandRegistry } from "./registry"

export const PI_SESSION_CONTROL_COMMAND_NAMES = ["compact", "model", "thinking", "skill"] as const
export type PiSessionControlCommandName = (typeof PI_SESSION_CONTROL_COMMAND_NAMES)[number]

export const THINKING_LEVEL_COMMAND_SUGGESTIONS = [
  { value: "off", description: "Disable reasoning effort" },
  { value: "minimal" },
  { value: "low" },
  { value: "medium" },
  { value: "high" },
  { value: "xhigh", label: "x-high" },
] as const

export function listServerCommandInfos(commandRegistry: CommandRegistry): CommandInfo[] {
  return commandRegistry.getCommandNames().map((name) => {
    const cmd = commandRegistry.get(name)!
    return {
      name,
      description: cmd.description,
      kind: CommandKinds.SERVER,
      scope: CommandScopes.WORKSPACE,
    }
  })
}

export function listClientActionCommandInfos(): CommandInfo[] {
  return [
    {
      name: DISCUSS_WITH_ARIADNE_COMMAND,
      description: "Open a private side-conversation with Ariadne about this thread",
      kind: CommandKinds.CLIENT_ACTION,
      scope: CommandScopes.STREAM,
      clientActionId: DISCUSS_WITH_ARIADNE_COMMAND,
    },
  ]
}

export function listWorkspaceCommandInfos(commandRegistry: CommandRegistry): CommandInfo[] {
  return [...listServerCommandInfos(commandRegistry), ...listClientActionCommandInfos()]
}

export function listPiSessionControlCommandInfos(): CommandInfo[] {
  return [
    {
      name: "compact",
      description: "Compact the linked Pi session",
      kind: CommandKinds.BOT_RUNTIME,
      scope: CommandScopes.STREAM,
      args: [{ name: "instructions", required: false, description: "Optional compaction focus" }],
    },
    {
      name: "model",
      description: "Set the linked Pi session model",
      kind: CommandKinds.BOT_RUNTIME,
      scope: CommandScopes.STREAM,
      args: [{ name: "model", required: true, description: "Model id or fuzzy model name" }],
    },
    {
      name: "thinking",
      description: "Set Pi thinking effort",
      kind: CommandKinds.BOT_RUNTIME,
      scope: CommandScopes.STREAM,
      args: [
        {
          name: "level",
          required: true,
          description: "Thinking effort",
          suggestions: [...THINKING_LEVEL_COMMAND_SUGGESTIONS],
        },
      ],
    },
    {
      name: "skill",
      description: "Find and run a Pi skill by fuzzy search",
      kind: CommandKinds.BOT_RUNTIME,
      scope: CommandScopes.STREAM,
      args: [{ name: "query", required: true, description: "Skill name or search terms" }],
    },
  ]
}
```

### New file: `apps/backend/src/features/commands/availability.ts`

Purpose: one backend resolver for command visibility and dispatch target resolution.

Imports needed:

```ts
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
```

Types:

```ts
export type ResolvedCommand =
  | { info: CommandInfo; executionKind: "server" }
  | { info: CommandInfo; executionKind: "client-action" }
  | {
      info: CommandInfo
      executionKind: "bot-runtime"
      runtime: PiRuntimeCommandTarget
    }

export interface PiRuntimeCommandTarget {
  botId: string
  rootStreamId: string
  activeStreamId: string
  responseStreamId: string
  targetInstanceId: string
  targetRuntimeSessionId: string
}

interface PiRuntimeTargetInternal extends PiRuntimeCommandTarget {
  link: BotRuntimeSessionLink
  presence: BotRuntimeInstance
}
```

Class skeleton:

```ts
export class CommandAvailabilityService {
  constructor(
    private readonly deps: {
      pool: Pool
      commandRegistry: CommandRegistry
    }
  ) {}

  listWorkspaceCommands(): CommandInfo[] {
    return listWorkspaceCommandInfos(this.deps.commandRegistry)
  }

  async listStreamCommands(params: { workspaceId: string; userId: string; streamId: string }): Promise<CommandInfo[]> {
    const resolved = await this.resolveStreamCommands(params)
    return resolved.map((c) => c.info)
  }

  async resolveCommand(params: {
    workspaceId: string
    userId: string
    streamId: string
    name: string
  }): Promise<ResolvedCommand | null> {
    const commands = await this.resolveStreamCommands(params)
    const lower = params.name.toLowerCase()
    return commands.find((c) => c.info.name.toLowerCase() === lower) ?? null
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
        if (isServerCommandAvailableInStream(info.name, stream, client)) {
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
          commands.push({ info, executionKind: CommandKinds.BOT_RUNTIME, runtime: runtimeTarget })
        }
      }

      return dedupeCommands(commands)
    })
  }
}
```

Implement helpers exactly enough for current behavior:

```ts
async function isServerCommandAvailableInStream(name: string, stream: Stream, db: Querier): Promise<boolean> {
  if (name !== "invite") return true
  if (stream.type === StreamTypes.CHANNEL) return true
  if (stream.type !== StreamTypes.THREAD || !stream.rootStreamId) return false
  const root = await StreamRepository.findById(db, stream.rootStreamId)
  return root?.type === StreamTypes.CHANNEL
}
```

Because this helper is async, implement the server loop with `for...of` and `await` rather than `filter()`.

```ts
function isClientActionAvailableInStream(info: CommandInfo, stream: Stream): boolean {
  if (info.clientActionId === DISCUSS_WITH_ARIADNE_COMMAND) return true
  return true
}
```

Runtime target resolver:

```ts
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

  if (!supportsSessionControlCommands(presence)) return null

  return {
    botId: bot.id,
    rootStreamId: rootStream.id,
    activeStreamId: stream.id,
    responseStreamId: stream.id,
    targetInstanceId: link.instanceId,
    targetRuntimeSessionId: link.runtimeSessionId,
    link,
    presence,
  }
}
```

Capability sanitizer:

```ts
function supportsSessionControlCommands(presence: BotRuntimeInstance): boolean {
  if (presence.capabilities.supportsSessionControlCommands !== true) return false
  const advertised = presence.capabilities.sessionControlCommands
  if (!Array.isArray(advertised)) return false
  const advertisedNames = new Set(advertised.filter((v): v is string => typeof v === "string"))
  return PI_SESSION_CONTROL_COMMAND_NAMES.some((name) => advertisedNames.has(name))
}
```

For v1, return the full allow-listed command set if any supported command is advertised. If you want stricter behavior, filter `listPiSessionControlCommandInfos()` by `advertisedNames`, but then update tests accordingly.

Deduper:

```ts
function dedupeCommands(commands: ResolvedCommand[]): ResolvedCommand[] {
  const byName = new Map<string, ResolvedCommand>()
  for (const command of commands) {
    byName.set(command.info.name.toLowerCase(), command)
  }
  return Array.from(byName.values())
}
```

### File: `apps/backend/src/features/commands/index.ts`

Export new helpers/classes:

```ts
export { CommandAvailabilityService } from "./availability"
export type { ResolvedCommand, PiRuntimeCommandTarget } from "./availability"
export {
  listWorkspaceCommandInfos,
  listPiSessionControlCommandInfos,
  PI_SESSION_CONTROL_COMMAND_NAMES,
} from "./catalog"
```

---

## 3. Backend command lifecycle event helpers

### New file: `apps/backend/src/features/commands/events.ts`

Purpose: share command lifecycle event creation between server command worker, runtime command dispatch, and public bot invocation completion/failure.

```ts
import type { Querier } from "../../db"
import { eventId } from "../../lib/id"
import { OutboxRepository } from "../../lib/outbox"
import { StreamEventRepository, type StreamEvent } from "../streams"
import {
  AuthorTypes,
  CommandKinds,
  type CommandCompletedPayload,
  type CommandDispatchedPayload,
  type CommandFailedPayload,
} from "@threa/types"
import { serializeBigInt } from "@threa/backend-common"

export interface RuntimeCommandInvocationMetadata {
  command: {
    id: string
    name: string
    args: string
    executionKind: typeof CommandKinds.BOT_RUNTIME
  }
}

export function buildRuntimeCommandInvocationMetadata(params: {
  commandId: string
  name: string
  args: string
}): RuntimeCommandInvocationMetadata {
  return {
    command: {
      id: params.commandId,
      name: params.name,
      args: params.args,
      executionKind: CommandKinds.BOT_RUNTIME,
    },
  }
}

export function parseRuntimeCommandInvocationMetadata(
  metadata: Record<string, unknown>
): RuntimeCommandInvocationMetadata["command"] | null {
  const command = metadata.command
  if (!command || typeof command !== "object") return null
  const value = command as Record<string, unknown>
  if (value.executionKind !== CommandKinds.BOT_RUNTIME) return null
  if (typeof value.id !== "string" || typeof value.name !== "string" || typeof value.args !== "string") return null
  return { id: value.id, name: value.name, args: value.args, executionKind: CommandKinds.BOT_RUNTIME }
}

export async function insertCommandDispatchedEvent(
  db: Querier,
  params: {
    workspaceId: string
    streamId: string
    userId: string
    commandId: string
    name: string
    args: string
    executionKind?: "server" | "bot-runtime"
  }
): Promise<StreamEvent> {
  const evt = await StreamEventRepository.insert(db, {
    id: eventId(),
    streamId: params.streamId,
    eventType: "command_dispatched",
    payload: {
      commandId: params.commandId,
      name: params.name,
      args: params.args,
      status: "dispatched",
      ...(params.executionKind && { executionKind: params.executionKind }),
    } satisfies CommandDispatchedPayload,
    actorId: params.userId,
    actorType: AuthorTypes.USER,
  })

  await OutboxRepository.insert(db, "command:dispatched", {
    workspaceId: params.workspaceId,
    streamId: params.streamId,
    event: serializeBigInt(evt),
    authorId: params.userId,
  })

  return evt
}

export async function insertCommandCompletedEvent(
  db: Querier,
  params: { workspaceId: string; streamId: string; userId: string; commandId: string; result?: unknown }
): Promise<StreamEvent> {
  const evt = await StreamEventRepository.insert(db, {
    id: eventId(),
    streamId: params.streamId,
    eventType: "command_completed",
    payload: { commandId: params.commandId, result: params.result } satisfies CommandCompletedPayload,
    actorId: params.userId,
    actorType: AuthorTypes.USER,
  })
  await OutboxRepository.insert(db, "command:completed", {
    workspaceId: params.workspaceId,
    streamId: params.streamId,
    authorId: params.userId,
    event: serializeBigInt(evt),
  })
  return evt
}

export async function insertCommandFailedEvent(
  db: Querier,
  params: { workspaceId: string; streamId: string; userId: string; commandId: string; error: string }
): Promise<StreamEvent> {
  const evt = await StreamEventRepository.insert(db, {
    id: eventId(),
    streamId: params.streamId,
    eventType: "command_failed",
    payload: { commandId: params.commandId, error: params.error } satisfies CommandFailedPayload,
    actorId: params.userId,
    actorType: AuthorTypes.USER,
  })
  await OutboxRepository.insert(db, "command:failed", {
    workspaceId: params.workspaceId,
    streamId: params.streamId,
    authorId: params.userId,
    event: serializeBigInt(evt),
  })
  return evt
}
```

Update `apps/backend/src/features/commands/index.ts` to export these helpers.

---

## 4. Wire availability service into routes/bootstrap

### File: `apps/backend/src/routes.ts`

Import `CommandAvailabilityService` from `./features/commands`.

After `const botRuntimeService = new BotRuntimeService({ pool })`, add:

```ts
const commandAvailabilityService = new CommandAvailabilityService({ pool, commandRegistry })
```

Pass it to:

```ts
createWorkspaceHandlers({ ..., commandAvailabilityService })
createStreamHandlers({ ..., commandAvailabilityService })
createCommandHandlers({ ..., commandAvailabilityService, botRuntimeService })
```

### File: `apps/backend/src/features/workspaces/handlers.ts`

Replace `commandRegistry` dependency usage for bootstrap command construction with `commandAvailabilityService.listWorkspaceCommands()`.

Dependencies:

```ts
import type { CommandAvailabilityService } from "../commands"

interface Dependencies {
  // remove commandRegistry if no longer used
  commandAvailabilityService: CommandAvailabilityService
}
```

In bootstrap handler replace current manual `commands` block with:

```ts
const commands = commandAvailabilityService.listWorkspaceCommands()
```

Remove direct imports of `CommandRegistry`, `CommandKinds`, `DISCUSS_WITH_ARIADNE_COMMAND`, and `CommandInfo` if unused.

### File: `apps/backend/src/features/streams/handlers.ts`

Add dependency:

```ts
import type { CommandAvailabilityService } from "../commands"

interface Dependencies {
  // existing
  commandAvailabilityService: CommandAvailabilityService
}
```

In `createStreamHandlers` destructuring include it.

In `bootstrap`, after stream access is validated and before `res.json`, fetch commands. Put it in the existing `Promise.all` block if clean, otherwise do immediately after the block.

Preferred simple version:

```ts
const commands = await commandAvailabilityService.listStreamCommands({ workspaceId, userId, streamId })
```

Add to response `data`:

```ts
commands,
```

Now the stream bootstrap returns complete effective commands for this stream.

---

## 5. Runtime command dispatch

### File: `apps/backend/src/features/commands/parser.ts`

Allow hyphenated names consistently with frontend/prosemirror:

```ts
const match = trimmed.match(/^\/([\w-]+)(?:\s+(.*))?$/s)
```

### File: `apps/backend/src/features/commands/handlers.ts`

Update dependencies:

```ts
import { CommandKinds, BotInvocationCapabilities, BotInvocationTriggers } from "@threa/types"
import type { BotRuntimeService } from "../bot-runtimes"
import type { CommandAvailabilityService } from "./availability"
import { buildRuntimeCommandInvocationMetadata, insertCommandDispatchedEvent } from "./events"
```

Dependencies:

```ts
interface Dependencies {
  pool: Pool
  commandRegistry: CommandRegistry
  streamService: StreamService
  commandAvailabilityService: CommandAvailabilityService
  botRuntimeService: BotRuntimeService
}
```

Dispatch flow pseudocode:

```ts
async dispatch(req, res) {
  const userId = req.user!.id
  const workspaceId = req.workspaceId!
  parse body
  parse command string

  // Resolve command availability for THIS stream. This replaces direct commandRegistry lookup.
  const resolved = await commandAvailabilityService.resolveCommand({
    workspaceId,
    userId,
    streamId,
    name: parsed.name,
  })

  if (!resolved) {
    const available = await commandAvailabilityService.listStreamCommands({ workspaceId, userId, streamId })
    return res.status(404).json({
      success: false,
      error: `Unknown command: ${parsed.name}`,
      availableCommands: available.map((c) => c.name),
    })
  }

  if (resolved.executionKind === CommandKinds.CLIENT_ACTION) {
    return res.status(400).json({ success: false, error: "Client-action commands cannot be dispatched to the server" })
  }

  if (resolved.executionKind === CommandKinds.SERVER) {
    return dispatchServerCommand(...)
  }

  return dispatchRuntimeCommand(...)
}
```

`dispatchServerCommand` should preserve current behavior but use `insertCommandDispatchedEvent`:

```ts
const cmdId = generateCommandId()
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
```

`dispatchRuntimeCommand` pseudocode:

```ts
const cmdId = generateCommandId()
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

  await botRuntimeService.createInvocationInTransaction(client, {
    workspaceId,
    rootStreamId: resolved.runtime.rootStreamId,
    activeStreamId: resolved.runtime.activeStreamId,
    sourceMessageId: cmdId,
    responseStreamId: resolved.runtime.responseStreamId,
    actorId: resolved.runtime.botId,
    trigger: BotInvocationTriggers.SESSION_CONTROL,
    requiredCapability: BotInvocationCapabilities.SESSION_CONTROL,
    promptMarkdown: `/${parsed.name}${parsed.args ? ` ${parsed.args}` : ""}`,
    authorUserId: userId,
    targetInstanceId: resolved.runtime.targetInstanceId,
    targetRuntimeSessionId: resolved.runtime.targetRuntimeSessionId,
    metadata: buildRuntimeCommandInvocationMetadata({ commandId: cmdId, name: parsed.name, args: parsed.args }),
  })

  return evt
})

return res.status(202).json({ success: true, commandId: cmdId, command: parsed.name, args: parsed.args, event })
```

### File: `apps/backend/src/features/bot-runtimes/service.ts`

Widen `createInvocation` trigger type to `BotInvocationTrigger` instead of the current literal union:

```ts
import type { BotInvocationCapability, BotInvocationTrigger, ... } from "@threa/types"

async createInvocation(params: {
  // ...
  trigger: BotInvocationTrigger
})
```

Add transaction variant:

```ts
async createInvocationInTransaction(
  db: Querier,
  params: {
    workspaceId: string
    rootStreamId: string
    activeStreamId: string
    sourceMessageId: string
    responseStreamId: string
    actorId: string
    trigger: BotInvocationTrigger
    requiredCapability: BotInvocationCapability
    promptMarkdown: string
    authorUserId: string
    mentionedActorSlugs?: string[]
    targetInstanceId?: string | null
    targetRuntimeSessionId?: string | null
    metadata?: Record<string, unknown>
  }
): Promise<BotInvocation> {
  return BotInvocationRepository.insertIdempotent(db, {
    id: botInvocationId(),
    workspaceId: params.workspaceId,
    rootStreamId: params.rootStreamId,
    activeStreamId: params.activeStreamId,
    sourceMessageId: params.sourceMessageId,
    responseStreamId: params.responseStreamId,
    actorType: "bot",
    actorId: params.actorId,
    trigger: params.trigger,
    requiredCapability: params.requiredCapability,
    promptMarkdown: params.promptMarkdown,
    authorUserId: params.authorUserId,
    mentionedActorSlugs: params.mentionedActorSlugs ?? [],
    targetInstanceId: params.targetInstanceId ?? null,
    targetRuntimeSessionId: params.targetRuntimeSessionId ?? null,
    metadata: params.metadata ?? {},
  })
}
```

Then make `createInvocation` call this method with `this.pool`:

```ts
return this.createInvocationInTransaction(this.pool, params)
```

Also update `createOrLinkPiRemoteSessionInTransaction` presence capabilities to include session control defaults:

```ts
capabilities: {
  supportsActiveScratchpad: true,
  supportsPersistentSessions: true,
  supportsSessionControlCommands: true,
  sessionControlCommands: ["compact", "model", "thinking", "skill"],
},
```

### File: `apps/backend/src/features/commands/outbox-handler.ts`

Do not enqueue runtime command events into the server command worker.

Update `CommandDispatchedEventPayload`:

```ts
interface CommandDispatchedEventPayload {
  commandId: string
  name: string
  args: string
  status: string
  executionKind?: string
}
```

Before `jobQueue.send`:

```ts
if (eventPayload.executionKind && eventPayload.executionKind !== CommandKinds.SERVER) {
  seen.push(event.id)
  continue
}
```

Missing `executionKind` remains server for backwards compatibility.

### File: `apps/backend/src/features/commands/worker.ts`

Replace private `createCompletedEvent` and `createFailedEvent` bodies with shared helper usage.

Pseudocode:

```ts
import { insertCommandCompletedEvent, insertCommandFailedEvent } from "./events"

async function createCompletedEvent(pool, params) {
  await withTransaction(pool, (client) => insertCommandCompletedEvent(client, params))
}

async function createFailedEvent(pool, params) {
  await withTransaction(pool, (client) => insertCommandFailedEvent(client, params))
}
```

Remove now-unused imports (`StreamEventRepository`, `OutboxRepository`, `eventId`, `serializeBigInt`) if they become unused.

---

## 6. Runtime invocation completion/failure -> command lifecycle events

### File: `apps/backend/src/features/public-api/routes.ts`

Add metadata to claim response schema:

```ts
const claimedInvocationSchema = z.object({
  // existing
  metadata: z.record(z.string(), z.unknown()),
})
```

No request schema changes beyond shared constants automatically accepting `session-control`.

### File: `apps/backend/src/features/public-api/handlers.ts`

Imports:

```ts
import {
  parseRuntimeCommandInvocationMetadata,
  insertCommandCompletedEvent,
  insertCommandFailedEvent,
} from "../commands"
import { BotInvocationCapabilities } from "@threa/types"
```

In `claimBotInvocation` response add:

```ts
metadata: invocation.metadata,
```

Skip agent-session rows for session-control invocations. Around the existing block that inserts `AgentSessionRepository.insertRunningOrSkip`, wrap with:

```ts
const isSessionControl = invocation.requiredCapability === BotInvocationCapabilities.SESSION_CONTROL
if (!isSessionControl && bot && !bot.archivedAt) {
  // existing AgentSessionRepository.insertRunningOrSkip block
}
```

In `completeBotInvocation`, after `completed` is created inside the transaction, insert a command completion event if metadata is present.

Inside the `withTransaction` callback after `completed` is non-null:

```ts
const runtimeCommand = parseRuntimeCommandInvocationMetadata(completed.metadata)
if (runtimeCommand) {
  await insertCommandCompletedEvent(client, {
    workspaceId: req.workspaceId!,
    streamId: completed.responseStreamId,
    userId: completed.authorUserId,
    commandId: runtimeCommand.id,
    result: {
      invocationId: completed.id,
      ...(message && { messageId: message.id }),
    },
  })
}
```

Keep this in the same transaction as the invocation completion (INV-7).

Update `failBotInvocation` to use a transaction and insert `command_failed` for runtime command metadata.

Add `failInvocationInTransaction` to `BotRuntimeService` first:

```ts
async failInvocationInTransaction(db: Querier, params: ...): Promise<BotInvocation | null> {
  return BotInvocationRepository.failClaim(db, params)
}
```

Then in handler:

```ts
const failed = await withTransaction(pool, async (client) => {
  const failed = await botRuntimeService.failInvocationInTransaction(client, {
    workspaceId: req.workspaceId!,
    botId: req.botApiKey!.botId,
    invocationId: req.params.invocationId,
    instanceId: result.data.instanceId,
    claimToken: result.data.claimToken,
    errorMessage: result.data.errorMessage,
  })
  if (!failed) throw new HttpError("Invocation claim not found", { status: 404, code: "NOT_FOUND" })

  const runtimeCommand = parseRuntimeCommandInvocationMetadata(failed.metadata)
  if (runtimeCommand) {
    await insertCommandFailedEvent(client, {
      workspaceId: req.workspaceId!,
      streamId: failed.responseStreamId,
      userId: failed.authorUserId,
      commandId: runtimeCommand.id,
      error: result.data.errorMessage,
    })
  }

  return failed
})
```

---

## 7. Frontend effective commands from stream bootstrap

### File: `apps/frontend/src/components/editor/triggers/types.ts`

Add optional metadata passthrough:

```ts
import type { CommandArgumentInfo, CommandKind, CommandScope } from "@threa/types"

export interface CommandItem {
  name: string
  description: string
  category?: string
  kind?: CommandKind
  scope?: CommandScope
  args?: CommandArgumentInfo[]
  clientActionId?: string
}
```

### File: `apps/frontend/src/components/editor/triggers/use-command-suggestion.tsx`

Imports:

```ts
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { streamKeys } from "@/hooks/use-streams"
import type { CachedStreamBootstrap } from "@/sync/stream-sync"
```

Add a small pure helper near top and export it for tests:

```ts
export function resolveEffectiveCommandInfos(
  workspaceCommands: readonly import("@threa/types").CommandInfo[] | undefined,
  streamCommands: readonly import("@threa/types").CommandInfo[] | undefined
) {
  return streamCommands ?? workspaceCommands ?? []
}
```

Inside hook:

```ts
const queryClient = useQueryClient()
const streamBootstrapKey = streamId ? streamKeys.bootstrap(workspaceId ?? "", streamId) : null
const { data: streamBootstrap } = useQuery({
  queryKey: streamBootstrapKey ?? ["streams", "bootstrap", workspaceId ?? "", ""],
  queryFn: () =>
    streamBootstrapKey ? (queryClient.getQueryData<CachedStreamBootstrap>(streamBootstrapKey) ?? null) : null,
  enabled: false,
  staleTime: Infinity,
})
```

Then command list:

```ts
const commands = useMemo<CommandItem[]>(() => {
  const effective = resolveEffectiveCommandInfos(metadata?.commands, streamBootstrap?.commands)
  return effective
    .filter((cmd) => {
      // Keep this for client-action safety only; backend now owns /invite filtering.
      if (cmd.clientActionId === DISCUSS_WITH_ARIADNE_COMMAND) return !!streamId
      return true
    })
    .map((cmd) => ({
      name: cmd.name,
      description: cmd.description,
      kind: cmd.kind,
      scope: cmd.scope,
      args: cmd.args,
      clientActionId: cmd.clientActionId,
    }))
}, [metadata?.commands, streamBootstrap?.commands, streamId])
```

Remove `isInviteAllowed()` and `useWorkspaceStreams()` usage from this hook if no longer needed.

### File: `apps/frontend/src/components/workspace-command-list.tsx`

This provider controls markdown rendering of `/foo` as a known command chip. It currently only uses workspace commands. Update it to use current route stream bootstrap if present.

Imports:

```ts
import { useParams } from "react-router-dom"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { streamKeys } from "@/hooks/use-streams"
import type { CachedStreamBootstrap } from "@/sync/stream-sync"
```

Inside component:

```ts
const { streamId } = useParams<{ streamId: string }>()
const queryClient = useQueryClient()
const streamBootstrapKey = streamId ? streamKeys.bootstrap(workspaceId, streamId) : null
const { data: streamBootstrap } = useQuery({
  queryKey: streamBootstrapKey ?? ["streams", "bootstrap", workspaceId, ""],
  queryFn: () =>
    streamBootstrapKey ? (queryClient.getQueryData<CachedStreamBootstrap>(streamBootstrapKey) ?? null) : null,
  enabled: false,
  staleTime: Infinity,
})

const commandNames = useMemo(() => {
  const effective = streamBootstrap?.commands ?? metadata?.commands ?? []
  return effective.map((c) => c.name)
}, [metadata?.commands, streamBootstrap?.commands])
```

This follows the repo’s cache-only observer pattern instead of direct `getQueryData()` in render.

### Optional frontend test

Add `apps/frontend/src/components/editor/triggers/use-command-suggestion.test.tsx` or a small utility test if test setup complains about hook imports.

Test pure helper:

```ts
import { describe, expect, test } from "bun:test"
import { resolveEffectiveCommandInfos } from "./use-command-suggestion"

describe("resolveEffectiveCommandInfos", () => {
  test("uses stream commands when present", () => {
    expect(
      resolveEffectiveCommandInfos(
        [{ name: "invite", description: "Invite" }],
        [{ name: "compact", description: "Compact" }]
      ).map((c) => c.name)
    ).toEqual(["compact"])
  })

  test("falls back to workspace commands before stream bootstrap loads", () => {
    expect(
      resolveEffectiveCommandInfos([{ name: "invite", description: "Invite" }], undefined).map((c) => c.name)
    ).toEqual(["invite"])
  })
})
```

---

## 8. Pi remote adapter execution

### File: `docs/examples/pi-remote/threa-remote-v2.ts`

#### Add constants

Near existing constants:

```ts
const SESSION_CONTROL_CAPABILITY = "session-control"
const SESSION_CONTROL_COMMANDS = ["compact", "model", "thinking", "skill"] as const
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const
type ThinkingLevel = (typeof THINKING_LEVELS)[number]
```

#### Extend claimed invocation type

Current `ClaimedInvocation` only has a few fields. Add:

```ts
type ClaimedInvocation = {
  id: string
  activeStreamId: string
  sourceMessageId: string
  promptMarkdown: string
  claimToken: string
  claimExpiresAt: string | null
  trigger?: string
  requiredCapability?: string
  metadata?: Record<string, unknown>
}
```

#### Advertise session control support in heartbeat

Add helper:

```ts
function buildRuntimeCapabilities(ctx?: ExtensionContext): Record<string, unknown> {
  return {
    supportsActiveScratchpad: true,
    supportsPersistentSessions: true,
    supportsMentionInvocations: true,
    supportsSessionControlCommands: true,
    sessionControlCommands: [...SESSION_CONTROL_COMMANDS],
    thinkingLevels: [...THINKING_LEVELS],
    ...(ctx?.model && {
      currentModel: `${ctx.model.provider}/${ctx.model.id}`,
    }),
    ...(ctx && { modelSuggestions: buildModelSuggestions(ctx) }),
  }
}
```

`buildModelSuggestions` should cap output to avoid bloated presence rows:

```ts
function buildModelSuggestions(ctx: ExtensionContext): Array<{ value: string; label: string }> {
  return ctx.modelRegistry
    .getAvailable()
    .filter((model) => model.input.includes("text"))
    .slice(0, 30)
    .map((model) => ({ value: `${model.provider}/${model.id}`, label: model.name }))
}
```

Change `heartbeat()` capabilities to:

```ts
capabilities: buildRuntimeCapabilities(ctx),
```

#### Claim session-control only when idle

Change `buildClaimInvocationPayload` to accept a flag:

```ts
function buildClaimInvocationPayload(
  instanceId: string,
  runtimeSessionId: string,
  options?: { includeSessionControl?: boolean }
): Record<string, unknown> {
  const supportedCapabilities = ["active-scratchpad", "mentionable"]
  if (options?.includeSessionControl) supportedCapabilities.push(SESSION_CONTROL_CAPABILITY)
  return {
    runtimeKind: "pi-local",
    instanceId,
    runtimeSessionId,
    supportedCapabilities,
    claimTtlSeconds: 120,
  }
}
```

Change `buildClaimInvocationBody(ctx)`:

```ts
function buildClaimInvocationBody(ctx: ExtensionContext): Record<string, unknown> {
  return buildClaimInvocationPayload(ensureInstanceId(), getRuntimeSessionId(ctx), {
    includeSessionControl: !pending && ctx.isIdle(),
  })
}
```

This prevents `/compact`/`/model`/`/thinking` from changing the active Pi turn mid-stream. They will be claimed once Pi is idle.

#### Metadata parser

Add:

```ts
type RuntimeCommandMetadata = { id: string; name: string; args: string; executionKind: "bot-runtime" }

function getRuntimeCommand(invocation: ClaimedInvocation): RuntimeCommandMetadata | null {
  const command = invocation.metadata?.command
  if (!command || typeof command !== "object") return null
  const value = command as Record<string, unknown>
  if (value.executionKind !== "bot-runtime") return null
  if (typeof value.id !== "string" || typeof value.name !== "string" || typeof value.args !== "string") return null
  return { id: value.id, name: value.name, args: value.args, executionKind: "bot-runtime" }
}

function isSessionControlInvocation(invocation: ClaimedInvocation): boolean {
  return invocation.requiredCapability === SESSION_CONTROL_CAPABILITY || getRuntimeCommand(invocation) !== null
}
```

#### Complete helper for non-pending command invocations

Add:

```ts
async function completeInvocationWithMarkdown(
  invocation: ClaimedInvocation,
  finalMessageMarkdown: string,
  ctx?: ExtensionContext
): Promise<void> {
  if (!config) return
  await request(`/api/v1/workspaces/${config.workspaceId}/bot-invocations/${invocation.id}/complete`, {
    method: "POST",
    body: JSON.stringify({
      instanceId: ensureInstanceId(),
      claimToken: invocation.claimToken,
      finalMessageMarkdown,
      metadata: {
        "pi.remote.invocationId": invocation.id,
        "pi.remote.instanceId": ensureInstanceId(),
        "pi.remote.sessionControl": "true",
      },
    }),
  })
  lastBusyHeartbeatAt = 0
  await heartbeat("available", undefined, ctx).catch(() => undefined)
}
```

#### Dispatch session-control invocations before normal prompt injection

In `claimIfIdle`, after `const invocation = await claimNextInvocation(ctx)`:

```ts
if (!invocation) return true
if (isSessionControlInvocation(invocation)) {
  await handleSessionControlInvocation(pi, ctx, invocation)
  return true
}
await injectInvocation(pi, ctx, invocation, steer)
return true
```

#### Handler pseudocode

```ts
async function handleSessionControlInvocation(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  invocation: ClaimedInvocation
): Promise<void> {
  const command = getRuntimeCommand(invocation)
  if (!command) {
    await failInvocation(invocation, "Missing runtime command metadata")
    return
  }

  try {
    await heartbeat("busy", `Running /${command.name}…`, ctx)
    switch (command.name) {
      case "compact":
        await runCompactCommand(invocation, command.args, ctx)
        return
      case "model":
        await runModelCommand(pi, invocation, command.args, ctx)
        return
      case "thinking":
        await runThinkingCommand(pi, invocation, command.args, ctx)
        return
      case "skill":
        await runSkillCommand(pi, invocation, command.args, ctx)
        return
      default:
        await failInvocation(invocation, `Unsupported session-control command: ${command.name}`)
    }
  } catch (error) {
    await failInvocation(invocation, error)
    lastBusyHeartbeatAt = 0
    await heartbeat("available", undefined, ctx).catch(() => undefined)
  }
}
```

#### `/compact`

```ts
function compactSession(ctx: ExtensionContext, customInstructions?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ctx.compact({
      customInstructions: customInstructions?.trim() || undefined,
      onComplete: () => resolve(),
      onError: (error) => reject(error),
    })
  })
}

async function runCompactCommand(invocation: ClaimedInvocation, args: string, ctx: ExtensionContext): Promise<void> {
  await compactSession(ctx, args)
  await completeInvocationWithMarkdown(invocation, "Compacted the linked Pi session.", ctx)
}
```

#### `/model`

```ts
type ModelCandidate = { value: string; label: string; model: NonNullable<ExtensionContext["model"]> }

function getModelCandidates(ctx: ExtensionContext): ModelCandidate[] {
  return ctx.modelRegistry
    .getAvailable()
    .filter((model) => model.input.includes("text"))
    .map((model) => ({ value: `${model.provider}/${model.id}`, label: model.name, model }))
}

function resolveModelCandidate(
  ctx: ExtensionContext,
  query: string
): { match?: ModelCandidate; candidates?: ModelCandidate[] } {
  const normalized = query.trim().toLowerCase()
  const candidates = getModelCandidates(ctx)
  if (!normalized) return { candidates: candidates.slice(0, 10) }

  const exact = candidates.filter(
    (c) =>
      c.value.toLowerCase() === normalized ||
      c.model.id.toLowerCase() === normalized ||
      c.label.toLowerCase() === normalized
  )
  if (exact.length === 1) return { match: exact[0] }
  if (exact.length > 1) return { candidates: exact.slice(0, 10) }

  const fuzzy = candidates.filter(
    (c) => c.value.toLowerCase().includes(normalized) || c.label.toLowerCase().includes(normalized)
  )
  if (fuzzy.length === 1) return { match: fuzzy[0] }
  return { candidates: fuzzy.slice(0, 10) }
}

async function runModelCommand(pi: ExtensionAPI, invocation: ClaimedInvocation, args: string, ctx: ExtensionContext) {
  const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown"
  const resolved = resolveModelCandidate(ctx, args)
  if (!resolved.match) {
    const lines = [
      args.trim() ? `No unique model match for \`${args.trim()}\`.` : `Current model: \`${current}\`.`,
      "Candidates:",
      ...(resolved.candidates ?? []).map((c) => `- \`${c.value}\` — ${c.label}`),
    ]
    await completeInvocationWithMarkdown(invocation, lines.join("\n"), ctx)
    return
  }

  const ok = await pi.setModel(resolved.match.model)
  if (!ok) throw new Error(`No API key configured for ${resolved.match.value}`)
  await completeInvocationWithMarkdown(invocation, `Model changed: \`${current}\` → \`${resolved.match.value}\``, ctx)
}
```

#### `/thinking`

```ts
function normalizeThinkingLevel(input: string): ThinkingLevel | null {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "")
  if (normalized === "none") return "off"
  if (normalized === "xhigh") return "xhigh"
  return THINKING_LEVELS.includes(normalized as ThinkingLevel) ? (normalized as ThinkingLevel) : null
}

async function runThinkingCommand(
  pi: ExtensionAPI,
  invocation: ClaimedInvocation,
  args: string,
  ctx: ExtensionContext
) {
  const level = normalizeThinkingLevel(args)
  if (!level) {
    await completeInvocationWithMarkdown(invocation, `Usage: \`/thinking ${THINKING_LEVELS.join("|")}\``, ctx)
    return
  }
  const before = pi.getThinkingLevel()
  pi.setThinkingLevel(level)
  const after = pi.getThinkingLevel()
  await completeInvocationWithMarkdown(invocation, `Thinking level changed: \`${before}\` → \`${after}\``, ctx)
}
```

#### `/skill`

This should resolve a skill and then run it as the pending Threa invocation so the final answer still posts back to Threa.

Refactor the repeated pending setup from `injectInvocation` into a helper:

```ts
function beginPendingInvocation(invocation: ClaimedInvocation, cursor?: string): void {
  pending = invocation
  pendingContextCursor = cursor
  pendingAssistantTexts = []
  pendingToolCalls = new Map()
  lastTraceHeartbeat = undefined
}
```

Use it inside existing `injectInvocation`.

Skill matching:

```ts
type PiCommand = ReturnType<ExtensionAPI["getCommands"]>[number]

function displaySkillName(command: PiCommand): string {
  return command.name.startsWith("skill:") ? command.name.slice("skill:".length) : command.name
}

function resolveSkillCommand(pi: ExtensionAPI, query: string): { match?: PiCommand; candidates: PiCommand[] } {
  const normalized = query.trim().toLowerCase()
  const skills = pi.getCommands().filter((command) => command.source === "skill")
  if (!normalized) return { candidates: skills.slice(0, 10) }

  const exact = skills.filter((command) => {
    const display = displaySkillName(command).toLowerCase()
    return command.name.toLowerCase() === normalized || display === normalized
  })
  if (exact.length === 1) return { match: exact[0], candidates: exact }
  if (exact.length > 1) return { candidates: exact.slice(0, 10) }

  const fuzzy = skills.filter((command) => {
    const haystack = [command.name, displaySkillName(command), command.description ?? ""].join(" ").toLowerCase()
    return haystack.includes(normalized)
  })
  if (fuzzy.length === 1) return { match: fuzzy[0], candidates: fuzzy }
  return { candidates: fuzzy.slice(0, 10) }
}
```

Run skill:

```ts
async function runSkillCommand(pi: ExtensionAPI, invocation: ClaimedInvocation, args: string, ctx: ExtensionContext) {
  const resolved = resolveSkillCommand(pi, args)
  if (!resolved.match) {
    const lines = [
      args.trim() ? `No unique skill match for \`${args.trim()}\`.` : "Tell me which skill to run.",
      "Candidates:",
      ...resolved.candidates.map((c) => `- \`/${c.name}\`${c.description ? ` — ${c.description}` : ""}`),
    ]
    await completeInvocationWithMarkdown(invocation, lines.join("\n"), ctx)
    return
  }

  beginPendingInvocation(invocation)
  await recordInvocationTraceStep(
    invocation,
    "context_received",
    `Resolved /skill ${args} to /${resolved.match.name}`,
    "Resolved skill…"
  )
  setRemoteStatus(ctx, `Threa remote: running ${invocation.id}`)
  pi.sendUserMessage(`/${resolved.match.name}`)
}
```

Because `pending` is set before `sendUserMessage`, existing `agent_end` will call `completePending(...)` and post the skill result back to Threa.

### File: `docs/examples/pi-remote/threa-remote-v2.test.ts`

Update existing claim payload test:

```ts
expect(
  __testing.buildClaimInvocationPayload("pi-host-123", "pi-session-abc", { includeSessionControl: true })
).toMatchObject({
  supportedCapabilities: ["active-scratchpad", "mentionable", "session-control"],
})
```

Add tests for:

- `normalizeThinkingLevel("x-high") === "xhigh"`
- `getRuntimeCommand(...)` parses metadata.
- `buildRuntimeCapabilities()` includes `supportsSessionControlCommands` and `sessionControlCommands`.

Export new helpers from `__testing`.

---

## 9. Backend tests

### File: `apps/backend/tests/client.ts`

Update `BootstrapData`:

```ts
import type { CommandInfo } from "@threa/types"

export interface BootstrapData {
  // existing
  commands?: CommandInfo[]
}
```

Add helper functions if desired:

```ts
export async function createBot(client: TestClient, workspaceId: string, body: Record<string, unknown>) {
  const { status, data } = await client.post<{ data: import("@threa/types").Bot }>(
    `/api/workspaces/${workspaceId}/bots`,
    body
  )
  if (status !== 201) throw new Error(`Create bot failed: ${JSON.stringify(data)}`)
  return data.data
}

export async function createBotKey(
  client: TestClient,
  workspaceId: string,
  botId: string,
  scopes: string[]
): Promise<string> {
  const { status, data } = await client.post<{ value: string } & { key: unknown }>(
    `/api/workspaces/${workspaceId}/bots/${botId}/keys`,
    {
      name: "runtime-test",
      scopes,
    }
  )
  if (status !== 201) throw new Error(`Create bot key failed: ${JSON.stringify(data)}`)
  return data.value
}

export async function botApiPost<T>(
  client: TestClient,
  workspaceId: string,
  path: string,
  apiKey: string,
  body: unknown
) {
  return client.request<T>("POST", `/api/v1/workspaces/${workspaceId}${path}`, body, {
    Authorization: `Bearer ${apiKey}`,
  })
}
```

If importing `Bot` causes type issues, use a local shape `{ id: string }`.

### File: `apps/backend/tests/e2e/commands.test.ts`

Add tests to existing `Command Visibility E2E` or a new `describe("Stream-scoped commands")`.

Setup helper pseudocode:

```ts
async function createLinkedPiSession(client: TestClient, workspaceId: string, suffix: string) {
  const bot = await createBot(client, workspaceId, {
    type: "personal",
    name: `Pi ${suffix}`,
    slug: `pi-${suffix}`,
    traits: ["active-scratchpad", "mentionable"],
  })

  const apiKey = await createBotKey(client, workspaceId, bot.id, [
    WORKSPACE_PERMISSION_SCOPES.BOT_RUNTIME_WRITE,
    WORKSPACE_PERMISSION_SCOPES.BOT_INVOCATIONS_WRITE,
  ])

  const session = await botApiPost<{
    data: { activeStreamId: string; rootStreamId: string; runtimeSessionId: string }
  }>(client, workspaceId, "/bot-runtime/sessions", apiKey, {
    runtimeKind: "pi-local",
    instanceId: `inst-${suffix}`,
    runtimeSessionId: `sess-${suffix}`,
    displayName: `Pi ${suffix}`,
    localCwd: "/tmp/threa-test",
  })
  expect(session.status).toBe(200)

  // Ensure current presence advertises session-control in case create session changes later.
  const presence = await botApiPost(client, workspaceId, "/bot-runtime/presence", apiKey, {
    runtimeKind: "pi-local",
    instanceId: `inst-${suffix}`,
    runtimeSessionId: `sess-${suffix}`,
    displayName: `Pi ${suffix}`,
    status: "available",
    acceptingInvocations: true,
    capabilities: {
      supportsActiveScratchpad: true,
      supportsPersistentSessions: true,
      supportsSessionControlCommands: true,
      sessionControlCommands: ["compact", "model", "thinking", "skill"],
    },
  })
  expect(presence.status).toBe(200)

  return {
    bot,
    apiKey,
    streamId: session.data.data.activeStreamId,
    runtimeSessionId: `sess-${suffix}`,
    instanceId: `inst-${suffix}`,
  }
}
```

Test listing:

```ts
test("Pi session-control commands are only listed in linked Pi scratchpads", async () => {
  const client = new TestClient()
  await loginAs(client, testEmail("pi-cmd-list"), "Pi Command User")
  const workspace = await createWorkspace(client, `Pi Cmd WS ${testRunId}`)
  const linked = await createLinkedPiSession(client, workspace.id, `list-${testRunId}`)

  const linkedBootstrap = await getBootstrap(client, workspace.id, linked.streamId)
  const linkedNames = linkedBootstrap.commands?.map((c) => c.name) ?? []
  expect(linkedNames).toContain("compact")
  expect(linkedNames).toContain("model")
  expect(linkedNames).toContain("thinking")
  expect(linkedNames).toContain("skill")

  const scratchpad = await createScratchpad(client, workspace.id, "off")
  const unlinkedBootstrap = await getBootstrap(client, workspace.id, scratchpad.id)
  const unlinkedNames = unlinkedBootstrap.commands?.map((c) => c.name) ?? []
  expect(unlinkedNames).not.toContain("compact")

  const channel = await createChannel(client, workspace.id, `pi-cmd-${testRunId}`, "public")
  const channelBootstrap = await getBootstrap(client, workspace.id, channel.id)
  const channelNames = channelBootstrap.commands?.map((c) => c.name) ?? []
  expect(channelNames).toContain("invite")
  expect(channelNames).not.toContain("compact")
})
```

Test dispatch + claim:

```ts
test("runtime command dispatch creates a targeted session-control invocation", async () => {
  const client = new TestClient()
  await loginAs(client, testEmail("pi-cmd-dispatch"), "Pi Command User")
  const workspace = await createWorkspace(client, `Pi Cmd Dispatch WS ${testRunId}`)
  const linked = await createLinkedPiSession(client, workspace.id, `dispatch-${testRunId}`)

  const dispatch = await dispatchCommand(client, workspace.id, linked.streamId, "/thinking high")
  expect(dispatch.success).toBe(true)
  expect(dispatch.command).toBe("thinking")
  expect((dispatch.event.payload as { executionKind?: string }).executionKind).toBe("bot-runtime")

  const claim = await botApiPost<{
    data: {
      id: string
      requiredCapability: string
      metadata: Record<string, unknown>
      runtimeSessionId: string | null
    } | null
  }>(client, workspace.id, "/bot-invocations/claim", linked.apiKey, {
    runtimeKind: "pi-local",
    instanceId: linked.instanceId,
    runtimeSessionId: linked.runtimeSessionId,
    supportedCapabilities: ["session-control"],
    claimTtlSeconds: 120,
  })

  expect(claim.status).toBe(200)
  expect(claim.data.data?.requiredCapability).toBe("session-control")
  expect(claim.data.data?.runtimeSessionId).toBe(linked.runtimeSessionId)
  expect((claim.data.data?.metadata.command as { name?: string } | undefined)?.name).toBe("thinking")
})
```

Test complete writes command_completed:

```ts
test("session-control invocation completion writes command_completed", async () => {
  // setup + dispatch + claim as above
  const invocation = claim.data.data!
  const metadataCommand = invocation.metadata.command as { id: string }

  const complete = await botApiPost(client, workspace.id, `/bot-invocations/${invocation.id}/complete`, linked.apiKey, {
    instanceId: linked.instanceId,
    claimToken: invocation.claimToken,
    finalMessageMarkdown: "Thinking level changed: `low` → `high`",
  })
  expect(complete.status).toBe(200)

  const events = await listEvents(client, workspace.id, linked.streamId)
  const completed = events.find((event) => event.eventType === "command_completed")
  expect((completed?.payload as { commandId?: string } | undefined)?.commandId).toBe(metadataCommand.id)
})
```

Adjust claimed response type to include `claimToken` in test shape.

---

## 10. Verification commands

Run focused tests first:

```bash
bun test ./docs/examples/pi-remote/threa-remote-v2.test.ts
bun test ./apps/backend/tests/e2e/commands.test.ts
```

Then typecheck:

```bash
bun run typecheck
```

If frontend pure tests are added:

```bash
bun test ./apps/frontend/src/components/editor/triggers/use-command-suggestion.test.tsx
```

---

## Known pitfalls

1. **Do not merge workspace + stream commands in the frontend.** Use stream commands when present because they are the complete effective list. Merging would leak `/invite` into scratchpads.
2. **Do not enqueue bot-runtime commands in the command worker.** `CommandHandler` must skip `executionKind: "bot-runtime"`.
3. **Do not create `agent_session:*` events for session-control invocations.** They are command lifecycle events, not normal agent runs. `/skill` is the exception on the Pi side: it sets `pending` and uses existing completion flow after resolving the skill.
4. **Do not trust arbitrary runtime command names.** Backend only surfaces the allow-listed Pi session-control commands, intersected/guarded by runtime capabilities.
5. **Keep command completion/failure events in the same transaction as invocation complete/fail.** This is the event-source/projection invariant (INV-7).
6. **Session-control claims should only be advertised by Pi when idle.** This avoids changing model/thinking/compacting during an active turn.
7. **No migration for new invocation capability/trigger.** These are text columns; updating constants is enough.
