import { die } from "./errors"
import { output, run } from "./shell"
import type { SpawnOptions } from "./types"

export function tmuxSession(options: SpawnOptions): string {
  return options.tmux ?? "0"
}

export function ensureTmuxSession(session: string): void {
  const result = output(["tmux", "has-session", "-t", session], { allowFailure: true })
  if (result.exitCode !== 0) die(`tmux session '${session}' not found`)
}

export function pickTmuxWindow(session: string, name: string): string {
  const existing = output(["tmux", "list-windows", "-t", session, "-F", "#{window_name}"])
    .stdout.split("\n")
    .filter(Boolean)
  if (!existing.includes(name)) return name
  return `${name}-${Math.floor(Math.random() * 10000)}`
}

export function capturePane(session: string, window: string, lines = 30): string {
  return output(["tmux", "capture-pane", "-t", `${session}:${window}`, "-p", "-S", `-${lines}`], {
    allowFailure: true,
  }).stdout
}

/** Send keys/tokens to a window's active program. `tmux send-keys` token rules apply (`Escape`, `Enter`, `-l` for literal text). */
export function sendKeys(session: string, window: string, keys: string[]): void {
  run(["tmux", "send-keys", "-t", `${session}:${window}`, ...keys])
}
