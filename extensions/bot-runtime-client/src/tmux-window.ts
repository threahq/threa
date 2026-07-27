import { spawnSync } from "node:child_process"

function paneTarget(): string | undefined {
  return process.env.THREA_TMUX_TARGET?.trim() || process.env.TMUX_PANE?.trim() || undefined
}

/**
 * Kill the tmux window the runtime lives in — deliberate self-termination for
 * the archived-scratchpad wind-down. The runtime dies with the window, so
 * callers do any last writes first.
 *
 * This is the runtime ending itself, not cleanup of somebody else's resources:
 * it needs no identity check because the pane is the one this process is in,
 * and it leaves harnessd's reaper an empty worktree rather than an occupied
 * one it would have to identify before touching.
 */
export function killOwnWindow(): boolean {
  const target = paneTarget()
  if (!target) return false
  try {
    return spawnSync("tmux", ["kill-window", "-t", target], { encoding: "utf8" }).status === 0
  } catch {
    return false
  }
}
