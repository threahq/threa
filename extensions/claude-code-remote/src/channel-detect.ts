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
export function isChannelLaunch(parentCommand: string, serverKey: string): boolean {
  const tokens = parentCommand.split(/\s+/)
  const target = `server:${serverKey}`
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

export type ChannelActivation = { active: true } | { active: false; reason: "no-server-key" | "flag-missing" }

/**
 * The launch flag names a server by its MCP registration key, but one Claude
 * session can load several registrations of this same script (identical argv),
 * and MCP gives a server no way to learn its own key. Matching the flag
 * against the hardcoded server name therefore activates EVERY instance —
 * including one Claude Code loaded as plain MCP, which then links the
 * scratchpad and silently eats invocations (its channel events are ignored).
 * The registration must carry its own key via THREA_CHANNEL_SERVER_KEY; an
 * instance whose registration doesn't declare one can never prove it is the
 * flagged server, so it must serve plain.
 */
export function channelActivation(parentCommand: string, serverKey: string | undefined): ChannelActivation {
  if (!serverKey) return { active: false, reason: "no-server-key" }
  return isChannelLaunch(parentCommand, serverKey) ? { active: true } : { active: false, reason: "flag-missing" }
}

/** The full command line of a process, or "" when unreadable (dead pid, no ps). */
export function readParentCommand(pid: number): string {
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim()
  } catch {
    return ""
  }
}
