import { capturePane, sendKeys } from "./tmux"

// All prompt patterns are line-anchored to the dialog's own chrome (the hint
// line or the highlighted-option line), never to prose: this repo's docs,
// sources, and test fixtures contain the literal strings "Switch model?",
// "Enter to confirm", and "❯ 1. Resume from summary", and managed agents work
// on this repo — an unanchored match against tool output in the transcript
// would type Enter into a healthy pane.
//
// Boot dialogs (trust prompt, development-channel warning, MCP-server approval,
// update notices) end with an "Enter to confirm/continue" hint on its own line.
const BOOT_DIALOG_RE = /^\s*(Press )?Enter to (confirm|continue)/m
// `/model <name>` in a session with history confirms behind a "Switch model?"
// cache-invalidation dialog with no Enter-hint line. It only ever appears
// because a model change was explicitly requested, and the highlighted option
// is "Yes, switch" — safe to answer.
const MODEL_SWITCH_DIALOG_RE = /^\s*❯\s*1\.\s*Yes, switch/m
const IDLE_PROMPT_RE = /^❯\s*$/m
// Claude Code's resume interstitial on old/large sessions ("This session is
// 2h 48m old and 274.9k tokens…"). It has NO Enter-hint line, so the boot
// dialog family misses it; the highlighted option is the recommended "Resume
// from summary", so a bare Enter selects it. This left three revived sessions
// blocked-but-reported-online on 2026-08-10.
const RESUME_PROMPT_RE = /^\s*❯\s*\d+\.\s*Resume from summary/m
// Any other highlighted numbered option is an interstitial we don't recognize:
// answering blind risks picking a destructive option, so it reports as blocked.
const MENU_PROMPT_RE = /^\s*❯\s*\d+\./m

export type ClaudePaneState = "idle" | "safe-dialog" | "resume-prompt" | "menu" | "working"

/**
 * Order matters twice over: a modal hides the composer (verified live on the
 * trust and switch-model dialogs), so a bare composer prompt proves no dialog
 * is up and idle wins first — transcript text on a settled pane must never
 * classify as a prompt. Below that, resume/dialog shapes also match the
 * generic menu pattern.
 */
export function classifyClaudePane(text: string): ClaudePaneState {
  if (IDLE_PROMPT_RE.test(text)) return "idle"
  if (RESUME_PROMPT_RE.test(text)) return "resume-prompt"
  if (BOOT_DIALOG_RE.test(text)) return "safe-dialog"
  if (MODEL_SWITCH_DIALOG_RE.test(text)) return "safe-dialog"
  if (MENU_PROMPT_RE.test(text)) return "menu"
  return "working"
}

/** The first highlighted option line — the one detail a blocked report needs. */
export function blockedPromptSummary(text: string): string {
  return text.match(/^\s*(❯\s*\d+\..*)$/m)?.[1]?.trim() ?? "unrecognized interactive prompt"
}

export interface ClaudeBootDeps {
  capture: (paneId: string) => string
  keys: (paneId: string, keys: string[]) => void
  sleep: (ms: number) => Promise<void>
}

export function defaultClaudeBootDeps(): ClaudeBootDeps {
  return { capture: capturePane, keys: sendKeys, sleep: Bun.sleep }
}

export interface ClaudeBootOutcome {
  settled: boolean
  state: "idle" | "blocked" | "timeout"
  lastCapture: string
}

/** Launch-path reporting for a boot that ended on an unrecognized prompt. */
export function warnIfBlocked(outcome: ClaudeBootOutcome): ClaudeBootOutcome {
  if (outcome.state === "blocked") {
    console.warn(
      `harnessd: Claude pane is blocked at an interactive prompt: ${blockedPromptSummary(outcome.lastCapture)}`
    )
  }
  return outcome
}

/**
 * Walk Claude Code through its boot dialogs by pressing Enter until the
 * composer prompt is idle. Polling capture-pane beats fixed sleeps: a fast
 * boot isn't held for the full wait and a slow one isn't abandoned with a
 * dialog still open (which left the channel half-wired often enough that the
 * old two-blind-Enters approach needed constant retuning).
 *
 * An unrecognized menu that persists returns `blocked` early so the caller can
 * report it — an honest `blocked` beats a silent timeout that reads as online.
 */
export async function acceptClaudeBootPrompts(
  paneId: string,
  deps: ClaudeBootDeps = defaultClaudeBootDeps(),
  opts?: { waitMs?: number }
): Promise<ClaudeBootOutcome> {
  const deadline = Date.now() + (opts?.waitMs ?? Number(process.env.THREA_HARNESSD_CLAUDE_BOOT_WAIT_MS ?? 45_000))
  let menuStreak = 0
  let text = ""
  while (Date.now() < deadline) {
    text = deps.capture(paneId)
    const state = classifyClaudePane(text)
    if (state === "resume-prompt" || state === "safe-dialog") {
      menuStreak = 0
      deps.keys(paneId, ["Enter"])
      await deps.sleep(1000)
      continue
    }
    if (state === "idle") return { settled: true, state: "idle", lastCapture: text }
    // Three consecutive sightings: a menu can flash mid-render, but one that
    // holds for ~1.5s is really waiting on a human.
    if (state === "menu") {
      if (++menuStreak >= 3) return { settled: false, state: "blocked", lastCapture: text }
    } else {
      menuStreak = 0
    }
    await deps.sleep(500)
  }
  console.warn("harnessd: Claude Code boot did not settle before the wait deadline; continuing")
  return { settled: false, state: "timeout", lastCapture: text }
}
