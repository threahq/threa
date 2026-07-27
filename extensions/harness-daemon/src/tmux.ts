import { die } from "./errors"
import { output, run } from "./shell"
import type { SpawnOptions } from "./types"

/**
 * The tmux session the user is actually looking at: the enclosing session when
 * running inside tmux, otherwise the first session with an attached client.
 * Spawned agent windows land where the user will see them instead of in a
 * hardcoded background session.
 */
export function attachedTmuxSession(): string | undefined {
  if (process.env.TMUX) {
    const result = output(["tmux", "display-message", "-p", "#{session_name}"], { allowFailure: true })
    const name = result.stdout.trim()
    if (result.exitCode === 0 && name) return name
  }
  const sessions = output(["tmux", "list-sessions", "-F", "#{session_attached} #{session_name}"], {
    allowFailure: true,
  })
  for (const line of sessions.stdout.split("\n")) {
    const match = line.match(/^([1-9]\d*) (.+)$/)
    if (match) return match[2]
  }
  return undefined
}

export function tmuxSession(options: SpawnOptions): string {
  return options.tmux ?? attachedTmuxSession() ?? "0"
}

export function ensureTmuxSession(session: string, create = false): void {
  const result = output(["tmux", "has-session", "-t", session], { allowFailure: true })
  if (result.exitCode === 0) return
  if (!create) die(`tmux session '${session}' not found`)
  run(["tmux", "new-session", "-d", "-s", session, "-n", "harnessd"])
}

export function pickTmuxWindow(session: string, name: string): string {
  const existing = output(["tmux", "list-windows", "-t", session, "-F", "#{window_name}"])
    .stdout.split("\n")
    .filter(Boolean)
  if (!existing.includes(name)) return name
  for (let i = 2; i < 100; i++) {
    const candidate = `${name}-${i}`
    if (!existing.includes(candidate)) return candidate
  }
  return `${name}-${Math.floor(Math.random() * 10000)}`
}

/**
 * Create a window at the session's first free index (the `session:` target —
 * no `-a`, which inserts relative to the *current* window and fails when the
 * next index is taken) and return its stable window + initial pane ids.
 * Detached (`-d`) so spawning into the user's attached session never yanks
 * focus away from what they're doing.
 */
export function createWindow(
  session: string,
  name: string,
  cwd: string,
  command: string
): { windowId: string; paneId: string } {
  const result = output([
    "tmux",
    "new-window",
    "-d",
    "-P",
    "-F",
    "#{window_id} #{pane_id}",
    "-t",
    `${session}:`,
    "-n",
    name,
    "-c",
    cwd,
    command,
  ])
  const [windowId, paneId] = result.stdout.trim().split(/\s+/)
  if (!windowId || !paneId) die("tmux new-window did not return window and pane ids")
  return { windowId, paneId }
}

export function respawnPane(target: string, cwd: string, command: string): void {
  run(["tmux", "respawn-pane", "-k", "-t", target, "-c", cwd, command])
}

export function capturePane(target: string, lines = 30): string {
  return output(["tmux", "capture-pane", "-t", target, "-p", "-S", `-${lines}`], {
    allowFailure: true,
  }).stdout
}

/** Send keys/tokens to a target's active program. `tmux send-keys` token rules apply (`Escape`, `Enter`, `-l` for literal text). */
export function sendKeys(target: string, keys: string[]): void {
  run(["tmux", "send-keys", "-t", target, ...keys])
}
