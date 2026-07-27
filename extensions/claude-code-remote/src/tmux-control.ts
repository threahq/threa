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

export interface TmuxPaneSnapshot {
  sessionName: string
  windowName: string
  windowId: string
  paneId: string
  panePid: number
  width: number
  height: number
  cwd: string
  branch: string | null
  view: string
}

export interface LocalCommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

export type LocalCommandRunner = (command: string[]) => LocalCommandResult

function runLocalCommand(command: string[]): LocalCommandResult {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" })
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

export function captureTmuxPaneSnapshot(run: LocalCommandRunner = runLocalCommand): TmuxPaneSnapshot {
  const target = paneTarget()
  if (!target) throw new Error("tmux pane target is unavailable")

  const details = run([
    "tmux",
    "display-message",
    "-p",
    "-t",
    target,
    "#{session_name}\t#{window_name}\t#{window_id}\t#{pane_id}\t#{pane_pid}\t#{pane_width}\t#{pane_height}\t#{pane_current_path}\t#{pane_dead}",
  ])
  if (details.exitCode !== 0) {
    throw new Error(details.stderr.trim() || `tmux could not inspect ${target}`)
  }
  const [sessionName, windowName, windowId, paneId, pidText, widthText, heightText, cwd, dead] = details.stdout
    .trimEnd()
    .split("\t")
  const panePid = Number(pidText)
  const width = Number(widthText)
  const height = Number(heightText)
  if (
    !sessionName ||
    !windowName ||
    !windowId ||
    !paneId ||
    !cwd ||
    dead !== "0" ||
    !Number.isSafeInteger(panePid) ||
    panePid <= 0 ||
    !Number.isSafeInteger(width) ||
    width <= 0 ||
    !Number.isSafeInteger(height) ||
    height <= 0
  ) {
    throw new Error(`tmux returned invalid pane details for ${target}`)
  }

  const captured = run(["tmux", "capture-pane", "-p", "-t", paneId])
  if (captured.exitCode !== 0) {
    throw new Error(captured.stderr.trim() || `tmux could not capture ${paneId}`)
  }
  const branchResult = run(["git", "-C", cwd, "branch", "--show-current"])
  return {
    sessionName,
    windowName,
    windowId,
    paneId,
    panePid,
    width,
    height,
    cwd,
    branch: branchResult.exitCode === 0 ? branchResult.stdout.trim() || null : null,
    view: captured.stdout
      .replace(/[ \t]+$/gm, "")
      .trim()
      .slice(-20_000),
  }
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

/**
 * Fold text into the RUNNING turn without interrupting it — Claude Code's
 * native steering: a message submitted while it works is injected into the
 * current turn. Pasted as one bracketed block (load-buffer + paste-buffer -p)
 * rather than typed with `-l`, so newlines in the text don't submit
 * mid-message and a leading `/` can't open the slash menu. Clears the input
 * line first (Ctrl-U) so residue doesn't concatenate into the steer.
 */
export async function steerText(text: string, opts: { settleMs?: number } = {}): Promise<boolean> {
  const target = paneTarget()
  if (!target) return false
  const settleMs = opts.settleMs ?? 150
  if (!sendKeys(["C-u"])) return false
  if (!pasteText(target, text)) return false
  if (settleMs > 0) await Bun.sleep(settleMs)
  return sendKeys(["Enter"])
}

function pasteText(target: string, text: string): boolean {
  try {
    const load = Bun.spawnSync(["tmux", "load-buffer", "-b", "threa-steer", "-"], {
      stdin: new TextEncoder().encode(text),
      stdout: "pipe",
      stderr: "pipe",
    })
    if (load.exitCode !== 0) return false
    const paste = Bun.spawnSync(["tmux", "paste-buffer", "-d", "-p", "-b", "threa-steer", "-t", target], {
      stdout: "pipe",
      stderr: "pipe",
    })
    return paste.exitCode === 0
  } catch {
    return false
  }
}
