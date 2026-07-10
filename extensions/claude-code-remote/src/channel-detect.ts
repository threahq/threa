import { execFileSync } from "node:child_process"

const DEV_CHANNELS_FLAG = "--dangerously-load-development-channels"

/**
 * Whether the parent Claude Code invocation loaded this server as a dev
 * channel. Claude Code negotiates identical MCP capabilities in channel and
 * plain mode (verified against 2.1.206 — the client declares no
 * `experimental["claude/channel"]`, sends no channel-specific message, and
 * sets no env var), so the launch flag on the parent process's command line
 * is the only observable channel signal. It is also the ground truth: the
 * flag is exactly what makes Claude Code treat this server as a channel.
 */
export function isChannelLaunch(parentCommand: string, channelSource: string): boolean {
  const tokens = parentCommand.split(/\s+/)
  const target = `server:${channelSource}`
  return tokens.some((token, i) => {
    if (token === DEV_CHANNELS_FLAG) return (tokens[i + 1] ?? "").split(",").includes(target)
    if (token.startsWith(`${DEV_CHANNELS_FLAG}=`)) {
      return token
        .slice(DEV_CHANNELS_FLAG.length + 1)
        .split(",")
        .includes(target)
    }
    return false
  })
}

/** The full command line of a process, or "" when unreadable (dead pid, no ps). */
export function readParentCommand(pid: number): string {
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim()
  } catch {
    return ""
  }
}
