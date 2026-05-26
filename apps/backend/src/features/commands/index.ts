/**
 * Commands feature - slash command infrastructure.
 *
 * Exports:
 * - HTTP handlers for command dispatch
 * - Command registry and base types
 * - Outbox handler for command job dispatching
 * - Worker for command execution
 * - Built-in commands
 */

// HTTP handlers
export { createCommandHandlers } from "./handlers"

// Command registry, availability, catalog, and types
export { CommandRegistry, parseCommand, isCommand } from "./registry"
export type { Command, CommandContext, CommandResult } from "./registry"
export { CommandAvailabilityService } from "./availability"
export type { ResolvedCommand, PiRuntimeCommandTarget } from "./availability"
export {
  PI_SESSION_CONTROL_COMMAND_NAMES,
  listWorkspaceCommandInfos,
  listPiSessionControlCommandInfos,
} from "./catalog"
export {
  buildRuntimeCommandInvocationMetadata,
  parseRuntimeCommandInvocationMetadata,
  insertCommandDispatchedEvent,
  insertCommandCompletedEvent,
  insertCommandFailedEvent,
} from "./events"
export type { RuntimeCommandInvocationMetadata } from "./events"

// Outbox handler
export { CommandHandler } from "./outbox-handler"
export type { CommandHandlerConfig } from "./outbox-handler"

// Worker
export { createCommandWorker } from "./worker"
export type { CommandWorkerDeps, CommandCompletedPayload, CommandFailedPayload } from "./worker"

// Built-in commands
export { InviteCommand } from "./invite-command"
