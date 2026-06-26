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
 * doesn't run). Verified live against Claude Code v2.1.193.
 *
 * `-l` sends the text verbatim so `/`, spaces, and punctuation aren't parsed as
 * tmux key names. A short settle between the text and Enter lets the slash-command
 * autocomplete resolve, so `/model sonnet` submits instead of the menu eating the
 * Enter.
 *
 * With `confirm`, a second Enter is sent after a longer settle to accept a modal
 * Claude Code may raise — `/model <x>` mid-session pops a "Switch model?" dialog
 * whose default option is "Yes"; without the confirm the session wedges at the
 * dialog. The trailing Enter is a harmless empty submit when no modal appears.
 */
export async function submitLine(text: string, opts: { settleMs?: number; confirm?: boolean } = {}): Promise<boolean> {
  const settleMs = opts.settleMs ?? 150
  if (!sendKeys(["C-u"])) return false
  if (!sendKeys(["-l", text])) return false
  if (settleMs > 0) await Bun.sleep(settleMs)
  if (!sendKeys(["Enter"])) return false
  if (opts.confirm) {
    // A modal Claude Code raises (e.g. "/model" mid-session pops "Switch model?")
    // may render slightly after the first Enter. Send two guarded, spaced Enters
    // so a late-rendering modal is still confirmed; an Enter on an empty prompt is
    // a harmless no-op. Guarded (unlike a fire-and-forget Enter) so a pane that
    // vanished mid-confirm reports failure instead of acking a false success.
    await Bun.sleep(CONFIRM_SETTLE_MS)
    if (!sendKeys(["Enter"])) return false
    await Bun.sleep(CONFIRM_SETTLE_MS)
    if (!sendKeys(["Enter"])) return false
  }
  return true
}

/** Milliseconds to wait after an interrupt before delivering the steer turn, so Claude has returned to idle. */
export const STEER_SETTLE_MS = 250
/** Wait for a modal (e.g. "Switch model?") to render before sending the confirming Enter. */
const CONFIRM_SETTLE_MS = 350
