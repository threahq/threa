import { ASIDE_COMMAND, CommandKinds, CommandScopes, type CommandInfo } from "@threa/types"
import type { CommandRegistry } from "./registry"

// Canonical session-control command names, shared across runtimes that drive a
// long-lived linked session (Pi, the Claude Code channel). Each runtime sees only
// the subset it advertises in `capabilities.sessionControlCommands`, so a command
// it doesn't advertise never surfaces for it (e.g. `skill` is Pi-only; `run` is
// Claude-channel-only; `compact`/`reload`/`kick` are advertised by both).
export const SESSION_CONTROL_COMMAND_NAMES = [
  "compact",
  "model",
  "thinking",
  "skill",
  "reload",
  "shell",
  "steer",
  "stop",
  "kick",
  "status",
  "run",
  "carry-on",
  "reconnect",
  "clear",
  "key",
  "spawn",
  "done",
] as const
export type SessionControlCommandName = (typeof SESSION_CONTROL_COMMAND_NAMES)[number]

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
      name: ASIDE_COMMAND,
      description: "Open a private aside with Ariadne beside what you are reading",
      kind: CommandKinds.CLIENT_ACTION,
      scope: CommandScopes.STREAM,
      clientActionId: ASIDE_COMMAND,
    },
  ]
}

export function listWorkspaceCommandInfos(commandRegistry: CommandRegistry): CommandInfo[] {
  return [...listServerCommandInfos(commandRegistry), ...listClientActionCommandInfos()]
}

export function listSessionControlCommandInfos(): CommandInfo[] {
  return [
    {
      name: "compact",
      description: "Compact the linked session",
      kind: CommandKinds.BOT_RUNTIME,
      scope: CommandScopes.STREAM,
      args: [{ name: "instructions", required: false, description: "Optional compaction focus" }],
    },
    {
      name: "model",
      description: "Set the linked session's model",
      kind: CommandKinds.BOT_RUNTIME,
      scope: CommandScopes.STREAM,
      args: [{ name: "model", required: true, description: "Model id or fuzzy model name" }],
    },
    {
      name: "thinking",
      description: "Set the linked session's thinking effort",
      kind: CommandKinds.BOT_RUNTIME,
      scope: CommandScopes.STREAM,
      // Level suggestions are model-specific; the resolver fills them in from the
      // runtime's advertised `thinkingLevels` capability at listing time.
      args: [{ name: "level", required: true, description: "Thinking effort" }],
    },
    {
      name: "skill",
      description: "Find and run a skill by fuzzy search",
      kind: CommandKinds.BOT_RUNTIME,
      scope: CommandScopes.STREAM,
      args: [{ name: "query", required: true, description: "Skill name or search terms" }],
    },
    {
      name: "reload",
      description: "Reload the linked session's extensions, skills, prompts, and themes",
      kind: CommandKinds.BOT_RUNTIME,
      scope: CommandScopes.STREAM,
    },
    {
      name: "shell",
      description: "Run a shell command in the linked session's working directory",
      kind: CommandKinds.BOT_RUNTIME,
      scope: CommandScopes.STREAM,
      args: [{ name: "command", required: true, description: "Shell command to run (passed to `$SHELL -c`)" }],
    },
    {
      name: "steer",
      description: "Steer the linked session with an immediate follow-up",
      kind: CommandKinds.BOT_RUNTIME,
      scope: CommandScopes.STREAM,
      args: [{ name: "message", required: false, description: "Optional instruction to inject immediately" }],
    },
    {
      name: "stop",
      description: "Stop the current turn in the linked session",
      kind: CommandKinds.BOT_RUNTIME,
      scope: CommandScopes.STREAM,
    },
    {
      name: "kick",
      description: "Nudge the linked session to continue",
      kind: CommandKinds.BOT_RUNTIME,
      scope: CommandScopes.STREAM,
    },
    {
      name: "status",
      description: "Show the linked session's connection, activity, and current terminal view",
      kind: CommandKinds.BOT_RUNTIME,
      scope: CommandScopes.STREAM,
    },
    {
      name: "run",
      description: "Run a slash command in the linked session",
      kind: CommandKinds.BOT_RUNTIME,
      scope: CommandScopes.STREAM,
      args: [{ name: "command", required: true, description: "Slash command to run, e.g. /compact" }],
    },
    {
      name: "carry-on",
      description: "Queue a message for when the session's provider quota resets",
      kind: CommandKinds.BOT_RUNTIME,
      scope: CommandScopes.STREAM,
      args: [{ name: "message", required: false, description: "Instruction to deliver when the session resumes" }],
    },
    {
      name: "reconnect",
      description: "Reconnect the linked live session",
      kind: CommandKinds.BOT_RUNTIME,
      scope: CommandScopes.STREAM,
      args: [{ name: "--force", required: false, description: "Reconnect despite local runtime activity" }],
    },
    {
      name: "clear",
      description: "Restart the linked session with a fresh conversation on this scratchpad",
      kind: CommandKinds.BOT_RUNTIME,
      scope: CommandScopes.STREAM,
      args: [{ name: "--force", required: false, description: "Clear despite local runtime activity" }],
    },
    {
      name: "key",
      description: "Send one allowed key to the linked live session",
      kind: CommandKinds.BOT_RUNTIME,
      scope: CommandScopes.STREAM,
      args: [{ name: "key", required: true, description: "Allowed key name" }],
    },
    {
      name: "spawn",
      description: "Start a coding session in a thread under this scratchpad",
      kind: CommandKinds.BOT_RUNTIME,
      scope: CommandScopes.STREAM,
      args: [
        {
          name: "name",
          required: true,
          description: "Optional runtime (claude or pi) then the session name; lines after the first are the prompt",
        },
      ],
    },
    {
      name: "done",
      description: "Wind down this thread's session: commit, push, remove the worktree, end the link",
      kind: CommandKinds.BOT_RUNTIME,
      scope: CommandScopes.STREAM,
      args: [{ name: "--force", required: false, description: "Finish despite local runtime activity" }],
    },
  ]
}
