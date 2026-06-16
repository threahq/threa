/**
 * Command infrastructure for slash commands.
 *
 * Commands are registered with the CommandRegistry and executed via
 * the job queue when dispatched from the command endpoint.
 */

import { logger } from "../../lib/logger"

export interface CommandContext {
  commandId: string
  commandName: string
  workspaceId: string
  streamId: string
  userId: string
  /** Arguments after the command name */
  args: string
}

export interface CommandResult {
  success: boolean
  error?: string
  result?: unknown
}

export interface Command {
  /** Command name without leading slash (e.g., "invite") */
  name: string
  description: string
  execute(ctx: CommandContext): Promise<CommandResult>
}

/**
 * Registry for slash commands.
 *
 * Commands are registered at startup and looked up when messages
 * starting with / are detected.
 */
export class CommandRegistry {
  private commands = new Map<string, Command>()

  /** Throws if a command with the same name is already registered. */
  register(command: Command): void {
    const name = command.name.toLowerCase()

    if (this.commands.has(name)) {
      throw new Error(`Command already registered: ${name}`)
    }

    this.commands.set(name, command)
    logger.info({ command: name }, "Command registered")
  }

  get(name: string): Command | undefined {
    return this.commands.get(name.toLowerCase())
  }

  has(name: string): boolean {
    return this.commands.has(name.toLowerCase())
  }

  getCommandNames(): string[] {
    return Array.from(this.commands.keys())
  }
}

export { parseCommand, isCommand } from "./parser"
