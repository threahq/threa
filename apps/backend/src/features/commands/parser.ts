/**
 * Parse slash commands from message content.
 *
 * Commands follow the format: /command [args]
 * Examples:
 *   /invite @alice @bob
 *   /help
 *   /status away
 */

export interface ParsedCommand {
  /** Command name without the leading slash (e.g., "invite") */
  name: string
  /** Everything after the command name, trimmed */
  args: string
}

/**
 * Check if a message is a command (starts with /).
 */
export function isCommand(content: string): boolean {
  return content.trimStart().startsWith("/")
}

/**
 * Parse a command from message content.
 *
 * Returns null if the content is not a valid command.
 * A valid command starts with / followed by a word character.
 */
export function parseCommand(content: string): ParsedCommand | null {
  const trimmed = content.trimStart()

  if (!trimmed.startsWith("/")) {
    return null
  }

  // Match: / followed by command name (word chars or hyphens), then optional whitespace + args
  const match = trimmed.match(/^\/([\w-]+)(?:\s+(.*))?$/s)

  if (!match) {
    // Starts with / but no valid command name (e.g., "/ " or "/123")
    return null
  }

  const [, name, args = ""] = match

  return {
    name: name.toLowerCase(),
    args: args.trim(),
  }
}
