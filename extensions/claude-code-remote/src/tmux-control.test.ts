import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { captureTmuxPaneSnapshot, submitModelChange, tmuxAvailable, type LocalCommandRunner } from "./tmux-control"

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
})
