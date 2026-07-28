import { capturePane, sendKeys } from "./tmux"

// Boot dialogs (trust prompt, development-channel warning, MCP-server approval,
// update notices) all end with an "Enter to confirm/continue" hint; the
// composer's input line is a bare "❯" only once boot has settled (during a
// dialog that line carries the highlighted option, e.g. "❯ 1. Use this MCP
// server").
const BOOT_DIALOG_RE = /Enter to confirm|Enter to continue/
const IDLE_PROMPT_RE = /^❯\s*$/m

export interface ClaudeBootDeps {
  capture: (paneId: string) => string
  keys: (paneId: string, keys: string[]) => void
  sleep: (ms: number) => Promise<void>
}

export function defaultClaudeBootDeps(): ClaudeBootDeps {
  return { capture: capturePane, keys: sendKeys, sleep: Bun.sleep }
}

/**
 * Walk Claude Code through its boot dialogs by pressing Enter until the
 * composer prompt is idle. Polling capture-pane beats fixed sleeps: a fast
 * boot isn't held for the full wait and a slow one isn't abandoned with a
 * dialog still open (which left the channel half-wired often enough that the
 * old two-blind-Enters approach needed constant retuning).
 */
export async function acceptClaudeBootPrompts(
  paneId: string,
  deps: ClaudeBootDeps = defaultClaudeBootDeps()
): Promise<void> {
  const deadline = Date.now() + Number(process.env.THREA_HARNESSD_CLAUDE_BOOT_WAIT_MS ?? 45_000)
  while (Date.now() < deadline) {
    const text = deps.capture(paneId)
    if (BOOT_DIALOG_RE.test(text)) {
      deps.keys(paneId, ["Enter"])
      await deps.sleep(1000)
      continue
    }
    if (IDLE_PROMPT_RE.test(text)) return
    await deps.sleep(500)
  }
  console.warn("harnessd: Claude Code boot did not settle before the wait deadline; continuing")
}
