import type { RemoteSessionStatusSnapshot } from "@threa/remote-session"
import { captureTmuxPaneSnapshot, type TmuxPaneSnapshot } from "./tmux-control"

export interface ClaudeChannelStatusContext {
  channelStarted: boolean
  instanceId: string
  runtimeSessionId: string
  remote: RemoteSessionStatusSnapshot
  quotaHolding: boolean
  pendingPermissionCount: number
  activeDelegationCount: number
}

function inlineCode(value: string): string {
  const longest = Math.max(0, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length))
  const fence = "`".repeat(Math.max(1, longest + 1))
  return `${fence}${value}${fence}`
}

function codeBlock(value: string): string {
  // Threa's markdown parser closes a fence on any line starting with ``` regardless
  // of fence length, so an inner fence is indented out of the way, not lengthened.
  const body = (value || "(pane is blank)")
    .split("\n")
    .map((line) => (line.startsWith("```") ? ` ${line}` : line))
    .join("\n")
  return `\`\`\`\n${body}\n\`\`\``
}

function connectivityLabel(context: ClaudeChannelStatusContext): string {
  if (!context.channelStarted || context.remote.stopped) return "Stopped"
  if (context.remote.linkState === "detached") return "Detached — scratchpad archived"
  if (context.remote.linkState === "unlinked") return "Connecting — scratchpad not linked"
  if (context.remote.socketConnected) return "Connected via WebSocket"
  return "WebSocket disconnected — HTTP fallback enabled"
}

function workLabel(context: ClaudeChannelStatusContext): string {
  if (context.quotaHolding) return "Waiting on provider quota"
  if (context.pendingPermissionCount > 0) return "Waiting on user permission"
  if (context.remote.inflightCount > 0) {
    return `Working — ${context.remote.inflightCount} active invocation${context.remote.inflightCount === 1 ? "" : "s"}`
  }
  if (context.activeDelegationCount > 0) {
    return `Working — ${context.activeDelegationCount} active delegation${context.activeDelegationCount === 1 ? "" : "s"}`
  }
  return "Idle"
}

export function formatClaudeStatusReport(
  context: ClaudeChannelStatusContext,
  pane: TmuxPaneSnapshot = captureTmuxPaneSnapshot()
): string {
  const lines = [
    "**Claude Code session status**",
    "",
    `- Threa: **${connectivityLabel(context)}**`,
    `- Work: **${workLabel(context)}**`,
  ]
  if (context.remote.rootStreamId) lines.push(`- Scratchpad: ${inlineCode(context.remote.rootStreamId)}`)
  if (context.pendingPermissionCount > 0) {
    lines.push(`- Pending permissions: ${context.pendingPermissionCount}`)
  }
  if (context.activeDelegationCount > 0) {
    lines.push(`- Active delegations: ${context.activeDelegationCount}`)
  }
  lines.push(
    `- Tmux: ${inlineCode(`${pane.sessionName}:${pane.windowName}`)} · pane ${inlineCode(pane.paneId)} · ${pane.width}×${pane.height}`,
    `- Process: PID ${pane.panePid}`,
    `- Branch: ${pane.branch ? inlineCode(pane.branch) : "not available"}`,
    `- Cwd: ${inlineCode(pane.cwd)}`,
    `- Runtime session: ${inlineCode(context.runtimeSessionId)}`,
    `- Instance: ${inlineCode(context.instanceId)}`,
    "",
    "**Current pane**",
    "",
    codeBlock(pane.view)
  )
  return lines.join("\n")
}
