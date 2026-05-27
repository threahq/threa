import { CommandKinds, CommandScopes, DISCUSS_WITH_ARIADNE_COMMAND, type CommandInfo } from "@threa/types"
import type { CommandRegistry } from "./registry"

export const PI_SESSION_CONTROL_COMMAND_NAMES = ["compact", "model", "thinking", "skill", "reload", "shell"] as const
export type PiSessionControlCommandName = (typeof PI_SESSION_CONTROL_COMMAND_NAMES)[number]

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
      // Level suggestions are model-specific; the resolver fills them in from the
      // runtime's advertised `thinkingLevels` capability at listing time.
      args: [{ name: "level", required: true, description: "Thinking effort" }],
    },
    {
      name: "skill",
      description: "Find and run a Pi skill by fuzzy search",
      kind: CommandKinds.BOT_RUNTIME,
      scope: CommandScopes.STREAM,
      args: [{ name: "query", required: true, description: "Skill name or search terms" }],
    },
    {
      name: "reload",
      description: "Reload Pi extensions, skills, prompts, and themes",
      kind: CommandKinds.BOT_RUNTIME,
      scope: CommandScopes.STREAM,
    },
    {
      name: "shell",
      description: "Run a shell command in the linked Pi session's working directory",
      kind: CommandKinds.BOT_RUNTIME,
      scope: CommandScopes.STREAM,
      args: [{ name: "command", required: true, description: "Shell command to run (passed to `$SHELL -c`)" }],
    },
  ]
}
