import { describe, expect, test } from "bun:test"
import { acceptClaudeBootPrompts, blockedPromptSummary, classifyClaudePane } from "./claude-boot"

const RESUME_PROMPT = [
  "  This session is 2h 48m old and 274.9k tokens.",
  "  Resuming the full session will consume a substantial portion of your usage",
  "  limits. We recommend resuming from a summary.",
  "❯ 1. Resume from summary (recommended)",
  "  2. Resume full session as-is",
  "  3. Don't ask me again",
].join("\n")

const UNKNOWN_MENU = ["Something new needs a decision", "❯ 1. Do the thing", "  2. Do the other thing"].join("\n")

describe("classifyClaudePane", () => {
  test("recognizes each interstitial family", () => {
    expect(classifyClaudePane(RESUME_PROMPT)).toBe("resume-prompt")
    expect(classifyClaudePane("Do you trust the files in this folder?\n❯ 1. Yes\nEnter to confirm")).toBe("safe-dialog")
    expect(classifyClaudePane(UNKNOWN_MENU)).toBe("menu")
    expect(classifyClaudePane("some output\n❯ \n")).toBe("idle")
    expect(classifyClaudePane("✻ Brewing…\n❯ queued message\nesc to interrupt")).toBe("working")
  })
})

describe("acceptClaudeBootPrompts", () => {
  test("answers the resume-from-summary interstitial and settles idle", async () => {
    // The 2026-08-10 incident: three revived sessions sat at this prompt while
    // presence reported them available. Enter selects the recommended option.
    const screens = [RESUME_PROMPT, "\n❯ \n"]
    const keys: string[][] = []
    let frame = 0
    const outcome = await acceptClaudeBootPrompts("%1", {
      capture: () => screens[Math.min(frame++, screens.length - 1)]!,
      keys: (_pane, sent) => void keys.push(sent),
      sleep: async () => undefined,
    })
    expect(keys).toEqual([["Enter"]])
    expect(outcome).toMatchObject({ settled: true, state: "idle" })
  })

  test("reports a persistent unrecognized menu as blocked without pressing anything", async () => {
    const keys: string[][] = []
    const outcome = await acceptClaudeBootPrompts("%1", {
      capture: () => UNKNOWN_MENU,
      keys: (_pane, sent) => void keys.push(sent),
      sleep: async () => undefined,
    })
    expect(keys).toEqual([])
    expect(outcome).toMatchObject({ settled: false, state: "blocked" })
    expect(blockedPromptSummary(outcome.lastCapture)).toBe("❯ 1. Do the thing")
  })
})
