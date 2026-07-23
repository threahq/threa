import { describe, expect, it } from "bun:test"
import { createClaudeSessionControl, runClaudeCommand } from "./channel-server"

function withTmuxEnv<T>(env: { TMUX?: string; TMUX_PANE?: string }, fn: () => T): T {
  const saved = {
    TMUX: process.env.TMUX,
    TMUX_PANE: process.env.TMUX_PANE,
    THREA_TMUX_TARGET: process.env.THREA_TMUX_TARGET,
    THREA_HARNESSD_ENTRYPOINT: process.env.THREA_HARNESSD_ENTRYPOINT,
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
        "status",
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

  it("advertises reconnect only with exact runtime, root, and harness entrypoint", () => {
    withTmuxEnv({ TMUX: "/tmp/tmux-1/default,1,0", TMUX_PANE: "%1" }, () => {
      expect(createClaudeSessionControl(undefined, "runtime", undefined, () => "root")!.commands).toContain("reconnect")
      expect(createClaudeSessionControl(undefined, "runtime", undefined, () => undefined)!.commands).not.toContain(
        "reconnect"
      )
      process.env.THREA_HARNESSD_ENTRYPOINT = "/definitely/missing/harnessd.ts"
      expect(createClaudeSessionControl(undefined, "runtime", undefined, () => "root")!.commands).not.toContain(
        "reconnect"
      )
    })
  })

  it("advertises key only with exact runtime, root, and a nonempty TMUX_PANE self-target", () => {
    withTmuxEnv({ TMUX: "/tmp/tmux-1/default,1,0", TMUX_PANE: "%1" }, () => {
      expect(createClaudeSessionControl(undefined, "runtime", undefined, () => "root")!.commands).toContain("key")
      expect(createClaudeSessionControl(undefined, "runtime", undefined, () => undefined)!.commands).not.toContain(
        "key"
      )
      expect(createClaudeSessionControl()!.commands).not.toContain("key")
    })
    withTmuxEnv({ TMUX: "/tmp/tmux-1/default,1,0" }, () => {
      process.env.THREA_TMUX_TARGET = "%9"
      expect(createClaudeSessionControl(undefined, "runtime", undefined, () => "root")!.commands).not.toContain("key")
    })
    withTmuxEnv({ TMUX: "/tmp/tmux-1/default,1,0", TMUX_PANE: "   " }, () => {
      process.env.THREA_TMUX_TARGET = "%9"
      expect(createClaudeSessionControl(undefined, "runtime", undefined, () => "root")!.commands).not.toContain("key")
    })
  })

  it("does not advertise /kick without a harness runtime identity", () => {
    withTmuxEnv({ TMUX: "/tmp/tmux-1/default,1,0", TMUX_PANE: "%1" }, () => {
      expect(createClaudeSessionControl()!.commands).toEqual([
        "stop",
        "steer",
        "status",
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
  it("accepts only empty or exact --force reconnect args", async () => {
    for (const args of ["--FORCE", "force", "--force=true", "--force --force", "extra"]) {
      expect(await runClaudeCommand("reconnect", args, undefined, "runtime", undefined, () => "root")).toEqual({
        ok: false,
        message: "Usage: `/reconnect [--force]`.",
      })
    }
    for (const args of ["", "--force"]) {
      const outcome = await runClaudeCommand("reconnect", args, undefined, "runtime", undefined, () => "root")
      expect(outcome.ok).toBe(true)
      expect(outcome.message).toBe("Reconnect request accepted; attempting to resume the linked Claude session.")
      expect(typeof outcome.afterAck).toBe("function")
    }
  })

  it("refuses non-force reconnect during in-flight or quota-held work", async () => {
    const busy = await runClaudeCommand(
      "reconnect",
      "",
      undefined,
      "runtime",
      undefined,
      () => "root",
      () => true
    )
    expect(busy).toEqual({ ok: false, message: "Claude is busy; retry when idle or use `/reconnect --force`." })
    expect(
      (
        await runClaudeCommand(
          "reconnect",
          "--force",
          undefined,
          "runtime",
          undefined,
          () => "root",
          () => true
        )
      ).ok
    ).toBe(true)
  })

  it("refuses non-force reconnect when work begins after the outcome but before afterAck", async () => {
    let busy = false
    const outcome = await runClaudeCommand(
      "reconnect",
      "",
      undefined,
      "runtime",
      undefined,
      () => "root",
      () => busy
    )

    expect(outcome.ok).toBe(true)
    busy = true
    await expect(outcome.afterAck?.()).rejects.toThrow(
      "Claude became busy after reconnect acknowledgement; retry when idle or use `/reconnect --force`."
    )
  })

  for (const lifecycle of ["shutdown", "archive→same-root restore"] as const) {
    it(`does not launch reconnect when ${lifecycle} wins during deferred delegation quiesce`, async () => {
      let releaseQuiesce!: () => void
      const quiesce = new Promise<void>((resolve) => (releaseQuiesce = resolve))
      let target: {
        stopped: boolean
        linkGeneration: number
        linkState: "unlinked" | "linked" | "detached"
        rootStreamId: string | undefined
      } = { stopped: false, linkGeneration: 1, linkState: "linked", rootStreamId: "root" }
      const outcome = await runClaudeCommand(
        "reconnect",
        "--force",
        undefined,
        "runtime",
        undefined,
        () => "root",
        undefined,
        () => quiesce,
        undefined,
        () => target
      )

      const postAck = outcome.afterAck?.()
      target =
        lifecycle === "shutdown"
          ? { stopped: true, linkGeneration: 1, linkState: "unlinked", rootStreamId: undefined }
          : { stopped: false, linkGeneration: 3, linkState: "linked", rootStreamId: "root" }
      releaseQuiesce()

      await expect(postAck).rejects.toThrow(
        "Remote session changed while delegation intake was quiescing; reconnect was not started."
      )
    })
  }

  it("does not launch reconnect when delegation quiesce fails and exposes intake restoration", async () => {
    const releaseError = new Error("delegation release failed: 500")
    let resets = 0
    const outcome = await runClaudeCommand(
      "reconnect",
      "--force",
      undefined,
      "runtime",
      undefined,
      () => "root",
      undefined,
      async () => {
        throw releaseError
      },
      () => {
        resets += 1
      }
    )

    await expect(outcome.afterAck?.()).rejects.toBe(releaseError)
    outcome.onHandoffReset?.()
    expect(resets).toBe(1)
  })

  it("sends one exact allowed key using Claude's parent PID", async () => {
    const sends: unknown[][] = []
    const outcome = await runClaudeCommand(
      "key",
      "ctrl-d",
      undefined,
      "runtime",
      undefined,
      () => "root",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      ((...args: unknown[]) => sends.push(args)) as any,
      { rootStreamId: "root" }
    )
    expect({ outcome, sends }).toEqual({
      outcome: { ok: true, message: "Sent `ctrl-d` to the linked Claude session." },
      sends: [["ctrl-d", process.ppid]],
    })
  })

  it("rejects a key claimed for root A after relinking to root B without sending", async () => {
    const sends: unknown[][] = []
    await expect(
      runClaudeCommand(
        "key",
        "enter",
        undefined,
        "runtime",
        undefined,
        () => "root-b",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        ((...args: unknown[]) => sends.push(args)) as any,
        { rootStreamId: "root-a" }
      )
    ).rejects.toThrow("Key control request no longer matches the linked scratchpad")
    expect(sends).toEqual([])
  })

  it("throws when key inspection or send fails", async () => {
    await expect(
      runClaudeCommand(
        "key",
        "enter",
        undefined,
        "runtime",
        undefined,
        () => "root",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        (() => {
          throw new Error("pane inspection failed")
        }) as any,
        { rootStreamId: "root" }
      )
    ).rejects.toThrow("pane inspection failed")
    await expect(runClaudeCommand("key", "enter", undefined, undefined, undefined, () => "root")).rejects.toThrow(
      "Key control is unavailable"
    )
  })

  it("rejects malformed key args without sending", async () => {
    for (const args of ["Enter", " enter", "enter ", "enter down", "-t", "%2", "unknown"]) {
      let sent = false
      expect(
        await runClaudeCommand(
          "key",
          args,
          undefined,
          "runtime",
          undefined,
          () => "root",
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          (() => {
            sent = true
          }) as any,
          { rootStreamId: "root" }
        )
      ).toEqual({ ok: false, message: "Usage: `/key <name>`." })
      expect(sent).toBe(false)
    }
  })

  it("fails loudly when /kick has no harness-managed runtime identity", async () => {
    expect(runClaudeCommand("kick", "")).rejects.toThrow("Harness kick is unavailable for this session.")
  })

  it("returns the injected read-only status report", async () => {
    const outcome = await runClaudeCommand("status", "", undefined, "ccs-one", () => "pane status")
    expect(outcome).toEqual({ ok: true, message: "pane status" })
  })

  it("reports status capture failures without throwing out of command handling", async () => {
    const outcome = await runClaudeCommand("status", "", undefined, "ccs-one", () => {
      throw new Error("pane disappeared")
    })
    expect(outcome).toEqual({ ok: false, message: "Could not inspect the session: pane disappeared" })
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
