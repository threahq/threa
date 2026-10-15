import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  captureTmuxPaneSnapshot,
  claudePaneShowsModal,
  steerText,
  submitModelChange,
  tmuxAvailable,
  type LocalCommandRunner,
} from "./tmux-control"

describe("tmuxAvailable", () => {
  const saved = {
    TMUX: process.env.TMUX,
    TMUX_PANE: process.env.TMUX_PANE,
    THREA_TMUX_TARGET: process.env.THREA_TMUX_TARGET,
  }

  beforeEach(() => {
    delete process.env.TMUX
    delete process.env.TMUX_PANE
    delete process.env.THREA_TMUX_TARGET
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it("is false outside tmux", () => {
    process.env.TMUX_PANE = "%5"
    expect(tmuxAvailable()).toBe(false)
  })

  it("is false inside tmux with no pane target", () => {
    process.env.TMUX = "/tmp/tmux-501/default,1234,0"
    expect(tmuxAvailable()).toBe(false)
  })

  it("is true inside tmux with a discovered pane", () => {
    process.env.TMUX = "/tmp/tmux-501/default,1234,0"
    process.env.TMUX_PANE = "%5"
    expect(tmuxAvailable()).toBe(true)
  })

  it("honours an explicit THREA_TMUX_TARGET override", () => {
    process.env.TMUX = "/tmp/tmux-501/default,1234,0"
    process.env.THREA_TMUX_TARGET = "work:claude.0"
    expect(tmuxAvailable()).toBe(true)
  })

  it("captures pane metadata, branch, and the visible terminal", () => {
    process.env.TMUX = "/tmp/tmux-501/default,1234,0"
    process.env.TMUX_PANE = "%5"
    const calls: string[][] = []
    const run: LocalCommandRunner = (command) => {
      calls.push(command)
      if (command[0] === "tmux" && command[1] === "display-message") {
        return {
          exitCode: 0,
          stdout: "1\tfeature\t@7\t%5\t33336\t180\t48\t/repo/threa.feature\t0\n",
          stderr: "",
        }
      }
      if (command[0] === "tmux" && command[1] === "capture-pane") {
        return { exitCode: 0, stdout: "Working…   \n\n", stderr: "" }
      }
      return { exitCode: 0, stdout: "feat/status\n", stderr: "" }
    }

    expect(captureTmuxPaneSnapshot(run)).toEqual({
      sessionName: "1",
      windowName: "feature",
      windowId: "@7",
      paneId: "%5",
      panePid: 33336,
      width: 180,
      height: 48,
      cwd: "/repo/threa.feature",
      branch: "feat/status",
      view: "Working…",
    })
    expect(calls.map((command) => command.slice(0, 2))).toEqual([
      ["tmux", "display-message"],
      ["tmux", "capture-pane"],
      ["git", "-C"],
    ])
  })

  it("fails loudly when the pane cannot be inspected", () => {
    process.env.TMUX = "/tmp/tmux-501/default,1234,0"
    process.env.TMUX_PANE = "%5"
    expect(() => captureTmuxPaneSnapshot(() => ({ exitCode: 1, stdout: "", stderr: "can't find pane: %5" }))).toThrow(
      "can't find pane: %5"
    )
  })

  // Captured 2026-08-10 (v2.1.226): /model in a session with history confirms
  // behind this dialog; without the answering Enter the pane sat blocked while
  // the channel reported the model as set.
  const SWITCH_DIALOG = [
    "Switch model?",
    "Your next response will be slower and use more tokens",
    "❯ 1. Yes, switch to Opus 5",
    "  2. No, go back",
  ].join("\n")

  it("submits /model and answers the switch-confirmation dialog", async () => {
    process.env.TMUX = "/tmp/tmux-501/default,1234,0"
    process.env.TMUX_PANE = "%5"
    const calls: string[][] = []
    const run: LocalCommandRunner = (command) => {
      calls.push(command)
      return { exitCode: 0, stdout: command[1] === "capture-pane" ? SWITCH_DIALOG : "", stderr: "" }
    }
    expect(await submitModelChange("opus", { settleMs: 0, pollMs: 0, run })).toEqual({ ok: true, confirmed: true })
    expect(calls).toEqual([
      ["tmux", "send-keys", "-t", "%5", "C-u"],
      ["tmux", "send-keys", "-t", "%5", "-l", "/model opus"],
      ["tmux", "send-keys", "-t", "%5", "Enter"],
      ["tmux", "capture-pane", "-p", "-t", "%5"],
      ["tmux", "send-keys", "-t", "%5", "Enter"],
    ])
  })

  it("reports an unknown alias instead of acking it as set", async () => {
    process.env.TMUX = "/tmp/tmux-501/default,1234,0"
    process.env.TMUX_PANE = "%5"
    const run: LocalCommandRunner = (command) => ({
      exitCode: 0,
      stdout: command[1] === "capture-pane" ? "❯ /model bogus\n  ⎿  Model 'bogus' not found\n❯ " : "",
      stderr: "",
    })
    expect(await submitModelChange("bogus", { settleMs: 0, pollMs: 0, run })).toEqual({
      ok: false,
      confirmed: false,
      unknownAlias: true,
    })
  })

  it("ignores dialog text quoted in the transcript (only the option line is chrome)", async () => {
    process.env.TMUX = "/tmp/tmux-501/default,1234,0"
    process.env.TMUX_PANE = "%5"
    const transcript = ['  ⎿  4    "Switch model?",', "  ⎿  5    // cache warning copy", "❯ "].join("\n")
    const enters: string[][] = []
    const run: LocalCommandRunner = (command) => {
      if (command[1] === "send-keys" && command.includes("Enter")) enters.push(command)
      return { exitCode: 0, stdout: command[1] === "capture-pane" ? transcript : "", stderr: "" }
    }
    expect(await submitModelChange("opus", { settleMs: 0, pollMs: 0, run })).toEqual({ ok: true, confirmed: false })
    expect(enters).toHaveLength(1)
  })

  it("presses nothing extra when the switch applies without a dialog", async () => {
    process.env.TMUX = "/tmp/tmux-501/default,1234,0"
    process.env.TMUX_PANE = "%5"
    const calls: string[][] = []
    const run: LocalCommandRunner = (command) => {
      calls.push(command)
      return { exitCode: 0, stdout: command[1] === "capture-pane" ? "❯ " : "", stderr: "" }
    }
    expect(await submitModelChange("sonnet", { settleMs: 0, pollMs: 0, run })).toEqual({ ok: true, confirmed: false })
    expect(calls.filter((command) => command.includes("Enter"))).toEqual([["tmux", "send-keys", "-t", "%5", "Enter"]])
    expect(calls.filter((command) => command[1] === "capture-pane")).toHaveLength(8)
  })

  const WORKING_WITH_COMPOSER = [
    "⏺ Reading the auth module",
    "  ⎿  Read 120 lines",
    "✻ Thinking… (12s · esc to interrupt)",
    "────────────────────────────────",
    "❯ ",
    "────────────────────────────────",
  ].join("\n")
  const PERMISSION_PROMPT = [
    "⏺ Bash(rm -rf build)",
    "────────────────────────────────",
    " Bash command",
    "   rm -rf build",
    " Do you want to proceed?",
    " ❯ 1. Yes",
    "   2. Yes, and don't ask again for rm commands",
    "   3. No, and tell Claude what to do differently (esc)",
  ].join("\n")
  const ASK_USER_QUESTION = [
    "☐ Approach",
    "Which storage should the cache use?",
    "❯ 1. Redis",
    "     Shared across replicas",
    "  2. In-memory",
    "  3. Type something.",
    "Enter to select · ↑/↓ to navigate · Esc to cancel",
  ].join("\n")
  const WORKING_NO_COMPOSER = [
    "⏺ Here is the plan:",
    "  1. Split the module",
    '  ⎿  "❯ 1. Yes" is the permission prompt fixture',
    "✻ Thinking… (3s · esc to interrupt)",
  ].join("\n")

  // Real Claude Code panes put a no-break space after ❯.
  const withNbsp = (screen: string) => screen.replace(/❯ /g, "❯\u00a0")

  it("reads a modal from dialog chrome, never from transcript text", () => {
    const read = (screen: string) => ({
      ascii: claudePaneShowsModal(screen),
      nbsp: claudePaneShowsModal(withNbsp(screen)),
    })
    expect({
      composer: read(WORKING_WITH_COMPOSER),
      permission: read(PERMISSION_PROMPT),
      askUserQuestion: read(ASK_USER_QUESTION),
      working: read(WORKING_NO_COMPOSER),
    }).toEqual({
      composer: { ascii: false, nbsp: false },
      permission: { ascii: true, nbsp: true },
      askUserQuestion: { ascii: true, nbsp: true },
      working: { ascii: false, nbsp: false },
    })
  })

  function steerRunner(captures: Array<{ exitCode: number; stdout: string }>) {
    const calls: Array<{ command: string[]; input?: string }> = []
    const run: LocalCommandRunner = (command, input) => {
      calls.push(input === undefined ? { command } : { command, input })
      if (command[1] === "capture-pane") return { ...captures.shift()!, stderr: "" }
      return { exitCode: 0, stdout: "", stderr: "" }
    }
    return { calls, run }
  }

  const composerShowing = (line: string) => withNbsp(WORKING_WITH_COMPOSER.replace(/^❯ $/m, line))

  it("steers over a composer: clears, pastes, then presses Enter once the paste shows", async () => {
    process.env.TMUX = "/tmp/tmux-501/default,1234,0"
    process.env.TMUX_PANE = "%5"
    const { calls, run } = steerRunner([
      { exitCode: 0, stdout: withNbsp(WORKING_WITH_COMPOSER) },
      { exitCode: 0, stdout: composerShowing("❯ go left") },
    ])
    expect(await steerText("go left", { settleMs: 0, run })).toBe(true)
    expect(calls).toEqual([
      { command: ["tmux", "capture-pane", "-p", "-t", "%5"] },
      { command: ["tmux", "send-keys", "-t", "%5", "C-u"] },
      { command: ["tmux", "load-buffer", "-b", "threa-steer", "-"], input: "go left" },
      { command: ["tmux", "paste-buffer", "-d", "-p", "-b", "threa-steer", "-t", "%5"] },
      { command: ["tmux", "capture-pane", "-p", "-t", "%5"] },
      { command: ["tmux", "send-keys", "-t", "%5", "Enter"] },
    ])
  })

  for (const [name, text, composer] of [
    ["dialog chrome in its own text", "pick one\nEnter to continue with B", "❯ pick one\n  Enter to continue with B"],
    ["a long paste collapsed by Claude Code", "go left\n".repeat(13), "❯ [Pasted text #1 +12 lines]"],
  ] as const) {
    it(`steers a message with ${name}`, async () => {
      process.env.TMUX = "/tmp/tmux-501/default,1234,0"
      process.env.TMUX_PANE = "%5"
      const { calls, run } = steerRunner([
        { exitCode: 0, stdout: WORKING_WITH_COMPOSER },
        { exitCode: 0, stdout: composerShowing(composer) },
      ])
      expect(await steerText(text, { settleMs: 0, run })).toBe(true)
      expect(calls.at(-1)).toEqual({ command: ["tmux", "send-keys", "-t", "%5", "Enter"] })
    })
  }

  for (const [name, capture] of [
    ["a permission prompt", { exitCode: 0, stdout: PERMISSION_PROMPT }],
    ["an AskUserQuestion menu", { exitCode: 0, stdout: withNbsp(ASK_USER_QUESTION) }],
    ["an unreadable pane", { exitCode: 1, stdout: "" }],
  ] as const) {
    it(`refuses to steer over ${name} without typing anything`, async () => {
      process.env.TMUX = "/tmp/tmux-501/default,1234,0"
      process.env.TMUX_PANE = "%5"
      const { calls, run } = steerRunner([capture])
      expect(await steerText("go left", { settleMs: 0, run })).toBe(false)
      expect(calls).toEqual([{ command: ["tmux", "capture-pane", "-p", "-t", "%5"] }])
    })
  }

  for (const [name, screen] of [
    ["a permission prompt", PERMISSION_PROMPT],
    ["an AskUserQuestion menu", ASK_USER_QUESTION],
  ] as const) {
    it(`withholds the Enter when ${name} opened while the paste settled`, async () => {
      process.env.TMUX = "/tmp/tmux-501/default,1234,0"
      process.env.TMUX_PANE = "%5"
      const { calls, run } = steerRunner([
        { exitCode: 0, stdout: WORKING_WITH_COMPOSER },
        { exitCode: 0, stdout: `❯ go left\n${withNbsp(screen)}` },
      ])
      expect(await steerText("go left", { settleMs: 0, run })).toBe(false)
      expect(calls.filter(({ command }) => command.includes("Enter"))).toEqual([])
    })
  }
})
