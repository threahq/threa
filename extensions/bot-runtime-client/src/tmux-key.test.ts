import { afterEach, describe, expect, it } from "bun:test"
import { parseAllowedTmuxKey, sendAllowedTmuxKey, TMUX_KEY_TOKENS } from "./tmux-key"

const originalPane = process.env.TMUX_PANE
afterEach(() => {
  if (originalPane === undefined) delete process.env.TMUX_PANE
  else process.env.TMUX_PANE = originalPane
})

function result(stdout = "", status = 0) {
  return { stdout, stderr: "", status, signal: null, pid: 1, output: [], error: undefined } as any
}

describe("allowlisted tmux keys", () => {
  it("maps all and only the initial names to fixed tmux tokens", () => {
    expect(TMUX_KEY_TOKENS).toEqual({
      escape: "Escape",
      enter: "Enter",
      up: "Up",
      down: "Down",
      left: "Left",
      right: "Right",
      tab: "Tab",
      backspace: "BSpace",
      "ctrl-c": "C-c",
      "ctrl-d": "C-d",
      "ctrl-u": "C-u",
    })
    for (const name of Object.keys(TMUX_KEY_TOKENS))
      expect(parseAllowedTmuxKey(name)).toBe(name as keyof typeof TMUX_KEY_TOKENS)
  })

  it("rejects aliases, casing, whitespace, multiple args, unknown names, and tmux-like tokens", () => {
    for (const value of ["esc", "Escape", " enter", "enter ", "enter down", "space", "C-c", "-t", "%2", ""]) {
      expect(parseAllowedTmuxKey(value)).toBeUndefined()
    }
  })

  it("inspects exact self target then sends one fixed token", () => {
    process.env.TMUX_PANE = "%7"
    const calls: unknown[][] = []
    const spawn = ((...args: unknown[]) => {
      calls.push(args)
      return calls.length === 1 ? result("%7\t4242\t0\n") : result()
    }) as any

    sendAllowedTmuxKey("ctrl-c", 4242, spawn)

    expect(calls).toEqual([
      ["tmux", ["display-message", "-p", "-t", "%7", "#{pane_id}\t#{pane_pid}\t#{pane_dead}"], { encoding: "utf8" }],
      ["tmux", ["send-keys", "-t", "%7", "C-c"], { encoding: "utf8" }],
    ])
  })

  it("does not send when pane inspection fails", () => {
    process.env.TMUX_PANE = "%7"
    let calls = 0
    const spawn = (() => {
      calls++
      return result("", 1)
    }) as any
    expect(() => sendAllowedTmuxKey("enter", 4242, spawn)).toThrow("could not inspect tmux pane")
    expect(calls).toBe(1)
  })

  it("reports a send failure after exactly one fixed send call", () => {
    process.env.TMUX_PANE = "%7"
    let calls = 0
    const spawn = (() => {
      calls++
      return calls === 1 ? result("%7\t4242\t0\n") : result("", 1)
    }) as any
    expect(() => sendAllowedTmuxKey("tab", 4242, spawn)).toThrow("could not send key")
    expect(calls).toBe(2)
  })

  it("never sends for missing, failed, stale, dead, malformed, or wrong-PID inspection", () => {
    const cases = [
      { pane: undefined, inspection: "%7\t4242\t0\n" },
      { pane: "%7", inspection: "%8\t4242\t0\n" },
      { pane: "%7", inspection: "%7\t4243\t0\n" },
      { pane: "%7", inspection: "%7\t4242\t1\n" },
      { pane: "%7", inspection: "%7\t4242\t0\textra\n" },
    ]
    for (const testCase of cases) {
      if (testCase.pane) process.env.TMUX_PANE = testCase.pane
      else delete process.env.TMUX_PANE
      const calls: unknown[][] = []
      const spawn = ((...args: unknown[]) => {
        calls.push(args)
        return result(testCase.inspection)
      }) as any
      expect(() => sendAllowedTmuxKey("enter", 4242, spawn)).toThrow()
      expect(calls.length).toBe(testCase.pane ? 1 : 0)
    }
  })
})
