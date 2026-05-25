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
