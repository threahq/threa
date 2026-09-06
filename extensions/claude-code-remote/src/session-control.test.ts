import { describe, expect, it } from "bun:test"
import { existsSync, readFileSync, unlinkSync } from "node:fs"
import type { HarnessSpawnSpec } from "@threahq/harness-client"
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

  it("advertises clear only with exact runtime, root, and harness entrypoint", () => {
    withTmuxEnv({ TMUX: "/tmp/tmux-1/default,1,0", TMUX_PANE: "%1" }, () => {
      expect(createClaudeSessionControl(undefined, "runtime", undefined, () => "root")!.commands).toContain("clear")
      expect(createClaudeSessionControl(undefined, "runtime", undefined, () => undefined)!.commands).not.toContain(
        "clear"
      )
      expect(createClaudeSessionControl()!.commands).not.toContain("clear")
      process.env.THREA_HARNESSD_ENTRYPOINT = "/definitely/missing/harnessd.ts"
      expect(createClaudeSessionControl(undefined, "runtime", undefined, () => "root")!.commands).not.toContain("clear")
    })
  })

  it("advertises kick only when the harness entrypoint exists", () => {
    // kick shells out to the same harnessd entrypoint reconnect uses, so an
    // uninstalled daemon makes it a dead button rather than a working command.
    withTmuxEnv({ TMUX: "/tmp/tmux-1/default,1,0", TMUX_PANE: "%1" }, () => {
      expect(createClaudeSessionControl(undefined, "runtime")!.commands).toContain("kick")
      process.env.THREA_HARNESSD_ENTRYPOINT = "/definitely/missing/harnessd.ts"
      const commands = createClaudeSessionControl(undefined, "runtime")!.commands
      expect(commands).not.toContain("kick")
      // The pane-driven commands are unaffected — this gate is about harnessd,
      // not about tmux.
      expect(commands).toEqual(expect.arrayContaining(["stop", "steer", "status", "model"]))
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

  it("advertises spawn only at the linked desk and done only inside a thread session", () => {
    const spawnOrDone = (activeStreamId: string | undefined, runtimeSessionId?: string) =>
      createClaudeSessionControl(
        undefined,
        runtimeSessionId,
        undefined,
        () => "root",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        () => activeStreamId
      )!.commands.filter((command) => command === "spawn" || command === "done")

    withTmuxEnv({ TMUX: "/tmp/tmux-1/default,1,0", TMUX_PANE: "%1" }, () => {
      expect({
        desk: spawnOrDone("root", "runtime"),
        thread: spawnOrDone("thread", "runtime"),
        unlinked: spawnOrDone(undefined, "runtime"),
        withoutRuntimeIdentity: spawnOrDone("root"),
      }).toEqual({ desk: ["spawn"], thread: ["done"], unlinked: [], withoutRuntimeIdentity: [] })

      process.env.THREA_HARNESSD_ENTRYPOINT = "/definitely/missing/harnessd.ts"
      expect({ desk: spawnOrDone("root", "runtime"), thread: spawnOrDone("thread", "runtime") }).toEqual({
        desk: [],
        thread: [],
      })
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

  it("accepts only empty or exact --force clear args", async () => {
    for (const args of ["--FORCE", "force", "--force=true", "--force --force", "extra"]) {
      expect(await runClaudeCommand("clear", args, undefined, "runtime", undefined, () => "root")).toEqual({
        ok: false,
        message: "Usage: `/clear [--force]`.",
      })
    }
    for (const args of ["", "--force"]) {
      const outcome = await runClaudeCommand("clear", args, undefined, "runtime", undefined, () => "root")
      expect(outcome.ok).toBe(true)
      expect(outcome.message).toBe(
        "Clear accepted — killing this session and starting a fresh conversation on the same scratchpad."
      )
      expect(typeof outcome.afterAck).toBe("function")
    }
  })

  it("refuses non-force clear during in-flight or quota-held work", async () => {
    const busy = await runClaudeCommand(
      "clear",
      "",
      undefined,
      "runtime",
      undefined,
      () => "root",
      () => true
    )
    expect(busy).toEqual({ ok: false, message: "Claude is busy; retry when idle or use `/clear --force`." })
    expect(
      (
        await runClaudeCommand(
          "clear",
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

  it("refuses non-force clear when work begins after the outcome but before afterAck", async () => {
    let busy = false
    const outcome = await runClaudeCommand(
      "clear",
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
      "Claude became busy after clear acknowledgement; retry when idle or use `/clear --force`."
    )
  })

  for (const lifecycle of ["shutdown", "archive→same-root restore"] as const) {
    it(`does not launch clear when ${lifecycle} wins during deferred delegation quiesce`, async () => {
      let releaseQuiesce!: () => void
      const quiesce = new Promise<void>((resolve) => (releaseQuiesce = resolve))
      let target: {
        stopped: boolean
        linkGeneration: number
        linkState: "unlinked" | "linked" | "detached"
        rootStreamId: string | undefined
      } = { stopped: false, linkGeneration: 1, linkState: "linked", rootStreamId: "root" }
      const outcome = await runClaudeCommand(
        "clear",
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
        "Remote session changed while delegation intake was quiescing; clear was not started."
      )
    })
  }

  it("does not launch clear when delegation quiesce fails and exposes intake restoration", async () => {
    const releaseError = new Error("delegation release failed: 500")
    let resets = 0
    const outcome = await runClaudeCommand(
      "clear",
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

  it("fails loudly when /clear has no harness-managed runtime identity", async () => {
    expect(runClaudeCommand("clear", "", undefined, undefined, undefined, () => "root")).rejects.toThrow(
      "Harness clear is unavailable for this session."
    )
  })

  /** The side effects of the last {@link runSpawn}, readable even when it rejected. */
  const spawnEffects: { specs: HarnessSpawnSpec[]; started: number } = { specs: [], started: 0 }

  const runSpawn = async (args: string, activeStreamId = "root") => {
    const specs: HarnessSpawnSpec[] = (spawnEffects.specs = [])
    spawnEffects.started = 0
    const outcome = await runClaudeCommand(
      "spawn",
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
      undefined,
      { rootStreamId: "root", sourceMessageId: "msg_slash_spawn" },
      () => activeStreamId,
      (spec: HarnessSpawnSpec) => {
        specs.push(spec)
        return () => {
          spawnEffects.started += 1
        }
      }
    )
    const brief = specs[0]?.briefFile
    const briefContent = brief ? readFileSync(brief, "utf8") : undefined
    if (brief) unlinkSync(brief)
    return { outcome, specs, started: spawnEffects.started, briefContent }
  }

  it("anchors the thread on the /spawn message, writes the brief, launches harnessd, and posts nothing", async () => {
    const { outcome, specs, started, briefContent } = await runSpawn("pi sidebar fix\nCollapse the sidebar.")

    expect({
      outcome,
      spec: { ...specs[0]!, briefFile: typeof specs[0]!.briefFile },
      started,
      briefContent,
    }).toEqual({
      outcome: { ok: true },
      spec: {
        runtime: "pi",
        name: "sidebar fix",
        rootStreamId: "root",
        anchorId: "msg_slash_spawn",
        briefFile: "string",
      },
      started: 1,
      briefContent: "Collapse the sidebar.",
    })
  })

  it("defaults /spawn to claude and passes no brief file for an empty prompt", async () => {
    const { outcome, specs, started, briefContent } = await runSpawn("tidy up")

    expect({ outcome, spec: specs[0], started, briefContent }).toEqual({
      outcome: { ok: true },
      spec: {
        runtime: "claude",
        name: "tidy up",
        rootStreamId: "root",
        anchorId: "msg_slash_spawn",
        briefFile: undefined,
      },
      started: 1,
      briefContent: undefined,
    })
  })

  it("returns /spawn usage without launching when the first line does not name an agent", async () => {
    for (const args of ["", "\nprompt only", "--force do it"]) {
      expect(await runSpawn(args)).toEqual({
        outcome: {
          ok: false,
          message: "Usage: `/spawn [claude|pi] <name>` with the prompt on the following lines.",
        },
        specs: [],
        started: 0,
        briefContent: undefined,
      })
    }
  })

  it("refuses a /spawn dispatched from inside a thread session", async () => {
    // The command list hides it there, but dispatch reaches every command by
    // name — a thread must not spawn siblings of itself under its own anchor.
    await expect(runSpawn("claude sidebar\nfix it", "thread")).rejects.toThrow(
      "Spawn is only available at the scratchpad itself, not inside a thread session."
    )
    expect(spawnEffects).toEqual({ specs: [], started: 0 })
  })

  it("removes the brief when the harnessd launch fails", async () => {
    let briefFile: string | undefined
    await expect(
      runClaudeCommand(
        "spawn",
        "pi broken\nfix the thing",
        undefined,
        "runtime",
        undefined,
        () => "root",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { rootStreamId: "root", sourceMessageId: "msg_slash_spawn" },
        () => "root",
        (spec: HarnessSpawnSpec) => {
          briefFile = spec.briefFile
          return () => {
            throw new Error("harnessd missing")
          }
        }
      )
    ).rejects.toThrow("harnessd missing")
    expect({ briefWritten: Boolean(briefFile), briefLeft: existsSync(briefFile ?? "") }).toEqual({
      briefWritten: true,
      briefLeft: false,
    })
  })

  const runDone = (
    args: string,
    activeStreamId: string,
    reconnectBusy?: () => boolean,
    invocationRootStreamId = "root"
  ) =>
    runClaudeCommand(
      "done",
      args,
      undefined,
      "runtime",
      undefined,
      () => "root",
      reconnectBusy,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { rootStreamId: invocationRootStreamId, sourceMessageId: "msg_slash" },
      () => activeStreamId
    )

  it("hands /done off through harnessd only from a thread session", async () => {
    for (const args of ["", "--force"]) {
      const outcome = await runDone(args, "thread")
      expect({ ok: outcome.ok, message: outcome.message, afterAck: typeof outcome.afterAck }).toEqual({
        ok: true,
        message: "Wrapping up: committing, pushing, removing the worktree and ending this thread's session.",
        afterAck: "function",
      })
    }
    for (const args of ["--FORCE", "force", "--force=true", "--force --force", "extra"]) {
      expect(await runDone(args, "thread")).toEqual({ ok: false, message: "Usage: `/done [--force]`." })
    }
    await expect(runDone("", "root")).rejects.toThrow("Done is only available inside a thread session.")
  })

  it("refuses a /done whose invocation names a different scratchpad than the linked one", async () => {
    // The session can be relinked between the dispatch and this handler; winding
    // down on a stale invocation would end whichever thread it points at now.
    await expect(runDone("", "thread", undefined, "other_root")).rejects.toThrow(
      "Done request no longer matches the linked scratchpad."
    )
  })

  it("refuses non-force /done while Claude is busy instead of killing the pane mid-turn", async () => {
    expect(await runDone("", "thread", () => true)).toEqual({
      ok: false,
      message: "Claude is busy; retry when idle or use `/done --force`.",
    })
    expect((await runDone("--force", "thread", () => true)).ok).toBe(true)
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
      { rootStreamId: "root", sourceMessageId: "msg_slash_spawn" }
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
        { rootStreamId: "root-a", sourceMessageId: "msg_slash" }
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
        { rootStreamId: "root", sourceMessageId: "msg_slash_spawn" }
      )
    ).rejects.toThrow("pane inspection failed")
    await expect(runClaudeCommand("key", "enter", undefined, undefined, undefined, () => "root")).rejects.toThrow(
      "Key control is unavailable"
    )
  })

  it("normalizes key-arg casing and whitespace before sending", async () => {
    const sends: unknown[][] = []
    const outcome = await runClaudeCommand(
      "key",
      "Enter",
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
      { rootStreamId: "root", sourceMessageId: "msg_slash_spawn" }
    )
    expect({ outcome, sends }).toEqual({
      outcome: { ok: true, message: "Sent `enter` to the linked Claude session." },
      sends: [["enter", process.ppid]],
    })
  })

  it("rejects malformed key args without sending", async () => {
    for (const args of ["enter down", "-t", "%2", "unknown"]) {
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
          { rootStreamId: "root", sourceMessageId: "msg_slash_spawn" }
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
