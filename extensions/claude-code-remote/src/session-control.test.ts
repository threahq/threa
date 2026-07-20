import { describe, expect, it } from "bun:test"
import { createClaudeSessionControl, runClaudeCommand } from "./channel-server"

function withTmuxEnv<T>(env: { TMUX?: string; TMUX_PANE?: string }, fn: () => T): T {
  const saved = {
    TMUX: process.env.TMUX,
    TMUX_PANE: process.env.TMUX_PANE,
    THREA_TMUX_TARGET: process.env.THREA_TMUX_TARGET,
  }
  delete process.env.THREA_TMUX_TARGET
  if (env.TMUX === undefined) delete process.env.TMUX
  else process.env.TMUX = env.TMUX
  if (env.TMUX_PANE === undefined) delete process.env.TMUX_PANE
  else process.env.TMUX_PANE = env.TMUX_PANE
  try {
    return fn()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

describe("createClaudeSessionControl", () => {
  it("returns no actuator outside tmux (fail-safe: no control → no commands offered)", () => {
    withTmuxEnv({}, () => {
      expect(createClaudeSessionControl()).toBeUndefined()
    })
  })

  it("advertises the full command set with effort levels and display-labelled models inside tmux", () => {
    withTmuxEnv({ TMUX: "/tmp/tmux-1/default,1,0", TMUX_PANE: "%1" }, () => {
      const actuator = createClaudeSessionControl(undefined, "ccs-one")
      expect(actuator).toBeDefined()
      expect(actuator!.commands).toEqual([
        "stop",
        "steer",
        "kick",
        "model",
        "thinking",
        "compact",
        "run",
        "reload",
        "carry-on",
      ])
      expect(actuator!.thinkingLevels).toEqual(["low", "medium", "high", "xhigh", "max", "ultracode"])
      expect(actuator!.modelSuggestions!.map((suggestion) => suggestion.value)).toContain("opus")
      expect(actuator!.modelSuggestions!.every((suggestion) => suggestion.label)).toBe(true)
      // Native mid-turn steering: without this the SDK falls back to interrupt+redeliver.
      expect(typeof actuator!.steer).toBe("function")
    })
  })

  it("does not advertise /kick without a harness runtime identity", () => {
    withTmuxEnv({ TMUX: "/tmp/tmux-1/default,1,0", TMUX_PANE: "%1" }, () => {
      expect(createClaudeSessionControl()!.commands).toEqual([
        "stop",
        "steer",
        "model",
        "thinking",
        "compact",
        "run",
        "reload",
        "carry-on",
      ])
    })
  })
})

describe("runClaudeCommand validation (paths that never touch tmux)", () => {
  it("fails loudly when /kick has no harness-managed runtime identity", async () => {
    expect(runClaudeCommand("kick", "")).rejects.toThrow("Harness kick is unavailable for this session.")
  })

  it("gives usage help for /model without an argument", async () => {
    const outcome = await runClaudeCommand("model", "")
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain("Usage")
  })

  it("rejects an unknown /thinking level instead of poking the effort slider", async () => {
    const outcome = await runClaudeCommand("thinking", "turbo")
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain("low, medium, high, xhigh, max, ultracode")
  })

  it("gives usage help for /run without an argument", async () => {
    const outcome = await runClaudeCommand("run", "")
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain("Usage")
  })

  it("reports an unadvertised command as unsupported", async () => {
    const outcome = await runClaudeCommand("skill", "whatever")
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain("Unsupported")
  })

  it("reports /carry-on as unavailable when no controller is wired (no tmux)", async () => {
    const outcome = await runClaudeCommand("carry-on", "later please")
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain("unavailable")
  })
})
