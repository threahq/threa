/**
 * Drive the Claude Code TUI from outside the process by sending keystrokes to the
 * tmux pane it runs in. Claude Code exposes no programmatic control to an MCP
 * server, so the pane is the only actuator: `Escape` interrupts the current turn;
 * literal text + `Enter` submits a prompt or a slash command (`/model`, `/compact`,
 * `/remote-control`, …). See docs/claude-channel-session-control.md.
 *
 * The target pane is discovered from `$TMUX_PANE`, which tmux sets inside the pane
 * and Claude Code inherits and passes to this MCP child. `THREA_TMUX_TARGET` is an
 * explicit override for tests or non-self-discovering launches. Both the env and
 * the target are read at call time so the value is never stale-captured.
 */

function paneTarget(): string | undefined {
  const explicit = process.env.THREA_TMUX_TARGET?.trim()
  if (explicit) return explicit
  const pane = process.env.TMUX_PANE?.trim()
  return pane || undefined
}

/** True only when we're inside tmux AND know which pane to drive. Gates whether the channel advertises session control at all (fail-safe: no control → no commands offered). */
export function tmuxAvailable(): boolean {
  return Boolean(process.env.TMUX && paneTarget())
}

function sendKeys(args: string[]): boolean {
  const target = paneTarget()
  if (!target) return false
  try {
    const result = Bun.spawnSync(["tmux", "send-keys", "-t", target, ...args], { stdout: "pipe", stderr: "pipe" })
    return result.exitCode === 0
  } catch {
    return false
  }
}

/** Interrupt the current Claude Code turn (single Esc). Harmless at an idle prompt. */
export function interrupt(): boolean {
  return sendKeys(["Escape"])
}

/**
 * Type literal text, then submit with Enter.
 *
 * Clears the input line first (Ctrl-U): an Esc-interrupt restores the interrupted
 * message back into Claude Code's input box, so a stale line would concatenate
 * with the command and get submitted as a plain prompt (the command silently
 * doesn't run).
 *
 * `-l` sends the text verbatim so `/`, spaces, and punctuation aren't parsed as
 * tmux key names. A short settle between the text and Enter lets the slash-command
 * autocomplete resolve, so `/model sonnet` submits instead of the menu eating the
 * Enter. Commands with an argument set directly in current Claude Code (v2.1.199
 * dropped the old mid-session "Switch model?" confirm dialog), so one submit is
 * the whole actuation.
 */
export async function submitLine(text: string, opts: { settleMs?: number } = {}): Promise<boolean> {
  const settleMs = opts.settleMs ?? 150
  if (!sendKeys(["C-u"])) return false
  if (!sendKeys(["-l", text])) return false
  if (settleMs > 0) await Bun.sleep(settleMs)
  return sendKeys(["Enter"])
}

/** Milliseconds to wait after an interrupt before delivering the steer turn, so Claude has returned to idle. */
export const STEER_SETTLE_MS = 250
