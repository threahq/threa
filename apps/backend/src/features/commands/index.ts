export { createCommandHandlers } from "./handlers"

export { CommandRegistry, parseCommand, isCommand } from "./registry"
export type { Command, CommandContext, CommandResult } from "./registry"
export { CommandAvailabilityService } from "./availability"
export type { ResolvedCommand, RuntimeCommandTarget } from "./availability"
export { SESSION_CONTROL_COMMAND_NAMES, listWorkspaceCommandInfos, listSessionControlCommandInfos } from "./catalog"
export {
  buildRuntimeCommandInvocationMetadata,
  parseRuntimeCommandInvocationMetadata,
  insertCommandDispatchedEvent,
  insertCommandCompletedEvent,
  insertCommandFailedEvent,
} from "./events"
export type { RuntimeCommandInvocationMetadata } from "./events"

export { CommandHandler } from "./outbox-handler"
export type { CommandHandlerConfig } from "./outbox-handler"

export { createCommandWorker } from "./worker"
export type { CommandWorkerDeps, CommandCompletedPayload, CommandFailedPayload } from "./worker"

export { InviteCommand } from "./invite-command"
