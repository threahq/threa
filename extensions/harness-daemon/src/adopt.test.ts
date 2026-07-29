import { describe, expect, test } from "bun:test"
import type { HarnessLink } from "@threa/bot-runtime-client"
import { adoptClaudeSessionUnlocked, type AdoptDeps, type AdoptOptions } from "./adopt"
import { acceptClaudeBootPrompts } from "./claude-boot"
import {
  findLiveClaudeSessions,
  resolveClaudeTranscript,
  resumableClaudeTranscript,
  type ClaudeDiskDeps,
} from "./claude-registry"
import { parseAdopt } from "./cli"
import { parseClaudeLaunch, type LocalTmuxPane } from "./discovery"
import { claudeLaunchArgs, claudeLaunchCommand, deriveClaudeRuntimeIdentity } from "./spawners"
import type { ManagedAgent } from "./types"

const CWD = "/Users/me/dev/slopenv"
const ROOT = "stream_01KYHVWXR862XKKND7SPZARH8K"
const NATIVE = "a65ee6cf-e1a5-44e3-842b-f9977f0907f7"
const START = "Tue Jul 28 09:43:27 2026"
const IDENTITY = deriveClaudeRuntimeIdentity(CWD)
const RUNTIME = IDENTITY.runtimeSessionId
const COMMAND = `env THREA_INSTANCE_ID=${IDENTITY.instanceId} THREA_RUNTIME_SESSION_ID=${RUNTIME} THREA_DISPLAY_NAME=CC claude --name slopenv --dangerously-load-development-channels server:threa-channel --dangerously-skip-permissions`

function pane(overrides: Partial<LocalTmuxPane> = {}): LocalTmuxPane {
  return {
    sessionName: "1",
    windowName: "claude-slopenv",
    windowId: "@204",
    paneId: "%211",
    panePid: 34341,
    cwd: CWD,
    startCommand: COMMAND,
    ...overrides,
  }
}

function link(overrides: Partial<HarnessLink> = {}): HarnessLink {
  return {
    runtimeKind: "claude-code-channel",
    runtimeSessionId: RUNTIME,
    instanceId: IDENTITY.instanceId,
    rootStreamId: ROOT,
    worktree: CWD,
    pid: 34379,
    updatedAt: "2026-07-28T09:43:29.959Z",
    ...overrides,
  }
}

function agent(overrides: Partial<ManagedAgent> = {}): ManagedAgent {
  return {
    id: "claude-adopted",
    name: "slopenv",
    runtime: "claude",
    status: "online",
    worktree: CWD,
    scratchpadUrl: `https://app.threa.io/w/ws_one/s/${ROOT}`,
    instanceId: IDENTITY.instanceId,
    runtimeSessionId: RUNTIME,
    command: ["threa-harnessd", "adopt", RUNTIME],
    createdAt: "2026-07-28T09:00:00.000Z",
    updatedAt: "2026-07-28T09:00:00.000Z",
    ...overrides,
  }
}

/** A filesystem where the cwd holds one dead session's transcript and no live process. */
function disk(overrides: Partial<ClaudeDiskDeps> = {}): ClaudeDiskDeps {
  return {
    home: "/home/me",
    canonical: (path) => path,
    exists: (path) => path.endsWith(`${NATIVE}.jsonl`),
    read: () => "{}",
    processStart: () => undefined,
    alive: () => false,
    list: (path) => (path.endsWith("projects/-Users-me-dev-slopenv") ? [`${NATIVE}.jsonl`] : []),
    modified: () => 1_000,
    ...overrides,
  }
}

interface Recorded {
  persisted: ManagedAgent[]
  launches: unknown[]
  killed: string[]
  preflights: unknown[]
  warnings: string[]
}

function deps(overrides: Partial<AdoptDeps> = {}): AdoptDeps & Recorded {
  const recorded: Recorded = { persisted: [], launches: [], killed: [], preflights: [], warnings: [] }
  return {
    ...recorded,
    claudeConfig: () => ({ baseUrl: "https://app.threa.io", workspaceId: "ws_one", apiKey: "key" }),
    inventory: () => [],
    panes: () => [],
    links: () => [link()],
    disk: disk(),
    isDirectory: () => true,
    scratchpadStatus: async () => "active",
    preflight: async (params) => {
      recorded.preflights.push(params)
      return { status: "linked", rootStreamId: ROOT }
    },
    launch: async (params) => {
      recorded.launches.push(params)
      return {
        tmuxSession: "1",
        tmuxWindow: "slopenv",
        tmuxWindowId: "@300",
        tmuxPaneId: "%301",
        output: "resumed",
      }
    },
    persist: (record) => void recorded.persisted.push(record),
    killWindow: (windowId) => void recorded.killed.push(windowId),
    newId: () => "claude-new",
    warn: (message) => void recorded.warnings.push(message),
    ...overrides,
  }
}

function options(overrides: Partial<AdoptOptions> = {}): AdoptOptions {
  return { runtimeSessionId: RUNTIME, rootStreamId: ROOT, ...overrides }
}

describe("adoptClaudeSession live pane", () => {
  test("records an unmanaged live pane without relaunching it", async () => {
    const dependencies = deps({ panes: () => [pane()] })
    const outcome = await adoptClaudeSessionUnlocked(options(), dependencies)

    expect(outcome).toEqual({
      status: "adopted live",
      detail: "1:claude-slopenv (%211, pid 34341), bypass enabled (live launch)",
    })
    expect(dependencies.launches).toEqual([])
    expect(dependencies.persisted).toEqual([
      {
        id: "claude-new",
        name: "slopenv",
        runtime: "claude",
        status: "online",
        worktree: CWD,
        branch: undefined,
        tmuxSession: "1",
        tmuxWindow: "claude-slopenv",
        tmuxWindowId: "@204",
        tmuxPaneId: "%211",
        scratchpadUrl: `https://app.threa.io/w/ws_one/s/${ROOT}`,
        instanceId: IDENTITY.instanceId,
        runtimeSessionId: RUNTIME,
        command: ["threa-harnessd", "adopt", RUNTIME, "--root-stream-id", ROOT, "--cwd", CWD, "--name", "slopenv"],
        createdAt: dependencies.persisted[0]!.createdAt,
        updatedAt: dependencies.persisted[0]!.updatedAt,
      },
    ])
  })

  test("preserves the original bypass setting on a session launched without it", async () => {
    const dependencies = deps({
      panes: () => [pane({ startCommand: COMMAND.replace(" --dangerously-skip-permissions", "") })],
    })
    await adoptClaudeSessionUnlocked(options(), dependencies)

    expect(dependencies.persisted[0]?.command).toContain("--no-yolo")
  })

  test("re-running against the same live pane reuses the row instead of adding one", async () => {
    const existing = agent({ tmuxPaneId: "%211" })
    const dependencies = deps({ panes: () => [pane()], inventory: () => [existing] })
    const outcome = await adoptClaudeSessionUnlocked(options(), dependencies)

    expect(outcome.status).toBe("already managed")
    expect(dependencies.persisted).toHaveLength(1)
    expect(dependencies.persisted[0]).toMatchObject({ id: "claude-adopted", createdAt: existing.createdAt })
  })

  test("adopts a session whose id the cwd no longer derives, on the link record's word", async () => {
    // The shape a hostname change leaves behind: the runtime keeps the id it
    // was born with, so `${host}:${cwd}` stops reproducing it. The pane carries
    // no THREA_* env either, so only the link record still binds the two.
    const drifted = "ccs-ac050fb309510f5c"
    const dependencies = deps({
      panes: () => [
        pane({
          startCommand:
            "/usr/bin/claude --name threa.leftie --dangerously-load-development-channels server:threa-channel --dangerously-skip-permissions",
        }),
      ],
      links: () => [link({ runtimeSessionId: drifted, instanceId: "cc-ac050fb309510f5c" })],
    })
    const outcome = await adoptClaudeSessionUnlocked(options({ runtimeSessionId: drifted }), dependencies)

    expect(outcome.status).toBe("adopted live")
    expect(dependencies.persisted[0]).toMatchObject({
      runtimeSessionId: drifted,
      instanceId: "cc-ac050fb309510f5c",
      worktree: CWD,
    })
  })

  test("dry run reports the live pane and touches nothing", async () => {
    const dependencies = deps({ panes: () => [pane()] })
    const outcome = await adoptClaudeSessionUnlocked(options({ dryRun: true }), dependencies)

    expect(outcome.status).toBe("would adopt live")
    expect(dependencies.persisted).toEqual([])
    expect(dependencies.preflights).toEqual([])
  })
})

describe("adoptClaudeSession cold takeover", () => {
  test("resumes the recovered transcript in a new window and records it", async () => {
    const dependencies = deps()
    const outcome = await adoptClaudeSessionUnlocked(options(), dependencies)

    expect(outcome).toEqual({
      status: "taken over",
      detail: `1:slopenv resuming ${NATIVE}, bypass disabled (default)`,
    })
    expect(dependencies.launches).toEqual([
      {
        name: "slopenv",
        cwd: CWD,
        tmux: undefined,
        resumeSessionId: NATIVE,
        rootStreamId: ROOT,
        identity: IDENTITY,
        noYolo: true,
      },
    ])
    expect(dependencies.persisted.at(-1)).toMatchObject({
      status: "online",
      tmuxWindowId: "@300",
      tmuxPaneId: "%301",
      worktree: CWD,
      runtimeSessionId: RUNTIME,
      instanceId: IDENTITY.instanceId,
    })
  })

  // The wait/error cold-start semantics live in `preflightRuntimeSession` and
  // in the launch command, not in these params — see the launch-command test.
  test("preflights the exact root with the adopted identity and cwd", async () => {
    const dependencies = deps()
    await adoptClaudeSessionUnlocked(options(), dependencies)

    expect(dependencies.preflights).toMatchObject([
      {
        baseUrl: "https://app.threa.io",
        workspaceId: "ws_one",
        apiKey: "key",
        runtimeKind: "claude-code-channel",
        instanceId: IDENTITY.instanceId,
        runtimeSessionId: RUNTIME,
        localCwd: CWD,
        expectedRootStreamId: ROOT,
        labelName: "coding",
      },
    ])
    // The display name follows THREA_DISPLAY_NAME / config, which the ambient
    // environment sets; only the worktree suffix is this code's contribution.
    expect((dependencies.preflights[0] as { displayName: string }).displayName).toEndWith(" - slopenv")
  })

  test("revives a stopped managed row through its own id, preserving the scratchpad", async () => {
    const dependencies = deps({ inventory: () => [agent({ status: "stopped" })] })
    const outcome = await adoptClaudeSessionUnlocked(options(), dependencies)

    expect(outcome.status).toBe("taken over")
    expect(dependencies.persisted.at(-1)).toMatchObject({
      id: "claude-adopted",
      status: "online",
      scratchpadUrl: `https://app.threa.io/w/ws_one/s/${ROOT}`,
    })
  })

  test("reuses the newest of several per-launch rows instead of adding another", async () => {
    const dependencies = deps({
      inventory: () => [
        agent({ id: "claude-first", updatedAt: "2026-07-28T09:00:00.000Z" }),
        agent({ id: "claude-newest", updatedAt: "2026-07-28T09:31:00.000Z", branch: "fix/boot" }),
      ],
    })
    await adoptClaudeSessionUnlocked(options(), dependencies)

    expect(dependencies.persisted.at(-1)).toMatchObject({ id: "claude-newest", branch: "fix/boot" })
  })

  test("carries a recorded --no-yolo into the takeover launch", async () => {
    const dependencies = deps({
      inventory: () => [agent({ command: ["threa-harnessd", "spawn", "claude", "--no-yolo"] })],
    })
    await adoptClaudeSessionUnlocked(options(), dependencies)

    expect(dependencies.launches).toMatchObject([{ noYolo: true }])
  })

  test("records the pinned conversation in the provenance command", async () => {
    const dependencies = deps({ disk: disk({ exists: () => true }) })
    await adoptClaudeSessionUnlocked(options({ claudeSessionId: NATIVE }), dependencies)

    // Without the pin, re-running the recorded command adopts the newest
    // transcript rather than the one the operator named.
    expect(dependencies.persisted.at(-1)?.command).toContain("--claude-session-id")
    expect(dependencies.persisted.at(-1)?.command).toContain(NATIVE)
  })

  test("dry run names the transcript it would resume without registering the session", async () => {
    const dependencies = deps()
    const outcome = await adoptClaudeSessionUnlocked(options({ dryRun: true }), dependencies)

    expect(outcome).toEqual({
      status: "would take over",
      detail: `${CWD} resuming ${NATIVE}, bypass disabled (default)`,
    })
    expect(dependencies.preflights).toEqual([])
    expect(dependencies.persisted).toEqual([])
    expect(dependencies.launches).toEqual([])
  })

  test("kills the window and records error when the scratchpad is archived mid-takeover", async () => {
    let probes = 0
    const dependencies = deps({ scratchpadStatus: async () => (++probes === 1 ? "active" : "archived") })
    const outcome = await adoptClaudeSessionUnlocked(options(), dependencies)

    expect(outcome.status).toBe("refused archived")
    expect(dependencies.killed).toEqual(["@300"])
    expect(dependencies.persisted.at(-1)).toMatchObject({ status: "error" })
  })
})

describe("adoptClaudeSession permission mode", () => {
  test("a takeover that cannot observe the original permission mode announces the downgrade", async () => {
    const dependencies = deps()
    const outcome = await adoptClaudeSessionUnlocked(options(), dependencies)

    expect(dependencies.launches).toMatchObject([{ noYolo: true }])
    expect(dependencies.warnings).toHaveLength(1)
    expect(dependencies.warnings[0]).toContain("--yolo")
    expect(outcome.detail).toContain("bypass disabled (default)")
  })

  test("--yolo keeps bypass on when nothing attests the original mode", async () => {
    const dependencies = deps()
    const outcome = await adoptClaudeSessionUnlocked(options({ yolo: true }), dependencies)

    expect(dependencies.launches).toMatchObject([{ noYolo: false }])
    expect(outcome.detail).toContain("bypass enabled (--yolo)")
    expect(dependencies.warnings).toEqual([])
  })

  test("a live pane's own bypass flag still wins over the default", async () => {
    const dependencies = deps({ panes: () => [pane()] })
    const outcome = await adoptClaudeSessionUnlocked(options(), dependencies)

    expect(outcome.detail).toContain("bypass enabled (live launch)")
    expect(dependencies.persisted[0]?.command).not.toContain("--no-yolo")
    expect(dependencies.warnings).toEqual([])
  })

  test("a live pane launched without bypass is followed, and that is not a downgrade", async () => {
    const dependencies = deps({
      panes: () => [pane({ startCommand: COMMAND.replace(" --dangerously-skip-permissions", "") })],
    })
    const outcome = await adoptClaudeSessionUnlocked(options(), dependencies)

    expect(outcome.detail).toContain("bypass disabled (live launch)")
    expect(dependencies.warnings).toEqual([])
  })

  test("an inventory row's recorded mode is followed when no pane is live", async () => {
    const dependencies = deps({
      inventory: () => [agent({ command: ["threa-harnessd", "spawn", "claude", "--no-yolo"] })],
    })
    const outcome = await adoptClaudeSessionUnlocked(options(), dependencies)

    expect(outcome.detail).toContain("bypass disabled (inventory row)")
    expect(dependencies.launches).toMatchObject([{ noYolo: true }])
    expect(dependencies.warnings).toEqual([])
  })

  test("an inventory row spawned with bypass keeps it", async () => {
    const dependencies = deps({ inventory: () => [agent()] })
    const outcome = await adoptClaudeSessionUnlocked(options(), dependencies)

    expect(outcome.detail).toContain("bypass enabled (inventory row)")
    expect(dependencies.launches).toMatchObject([{ noYolo: false }])
    expect(dependencies.warnings).toEqual([])
  })

  test("a refusal does not announce a downgrade it never applied", async () => {
    const dependencies = deps({ disk: disk({ list: () => [] }) })
    const outcome = await adoptClaudeSessionUnlocked(options(), dependencies)

    expect(outcome.status).toBe("refused missing transcript")
    expect(dependencies.launches).toEqual([])
    expect(dependencies.warnings).toEqual([])
  })

  test("a dry run previews the downgrade without announcing one", async () => {
    const dependencies = deps()
    const outcome = await adoptClaudeSessionUnlocked(options({ dryRun: true }), dependencies)

    expect(outcome.detail).toContain("bypass disabled (default)")
    expect(dependencies.warnings).toEqual([])
  })

  test("a flag that disagrees with the live pane is reported as not applied", async () => {
    const dependencies = deps({ panes: () => [pane()] })
    const outcome = await adoptClaudeSessionUnlocked(options({ noYolo: true }), dependencies)

    expect(outcome.detail).toContain("bypass enabled (live launch)")
    expect(dependencies.launches).toEqual([])
    expect(dependencies.warnings).toHaveLength(1)
    expect(dependencies.warnings[0]).toContain("not being restarted")
  })

  test("a live pane records the mode it is running, not the flag it was adopted with", async () => {
    const dependencies = deps({ panes: () => [pane()] })
    await adoptClaudeSessionUnlocked(options({ yolo: true }), dependencies)

    expect(dependencies.persisted.at(-1)?.command).not.toContain("--yolo")
    expect(dependencies.persisted.at(-1)?.command).not.toContain("--no-yolo")
  })

  test("a contradictory programmatic decision never records both flags", async () => {
    const dependencies = deps()
    await adoptClaudeSessionUnlocked(options({ yolo: true, noYolo: true }), dependencies)

    const command = dependencies.persisted.at(-1)?.command ?? []
    expect(command).toContain("--no-yolo")
    expect(command).not.toContain("--yolo")
  })

  test("--yolo and --no-yolo together are refused at parse time", () => {
    expect(() => parseAdopt([RUNTIME, "--root-stream-id", ROOT, "--yolo", "--no-yolo"])).toThrow(/--yolo/)
    expect(parseAdopt([RUNTIME, "--root-stream-id", ROOT, "--yolo"])).toMatchObject({ yolo: true, noYolo: undefined })
  })

  test("a dry run reports the permission decision it would apply", async () => {
    const outcome = await adoptClaudeSessionUnlocked(options({ dryRun: true }), deps())

    expect(outcome.status).toBe("would take over")
    expect(outcome.detail).toContain("bypass disabled (default)")
  })

  test("the recorded adopt command carries --yolo", async () => {
    const stated = deps()
    await adoptClaudeSessionUnlocked(options({ yolo: true }), stated)

    expect(stated.persisted.at(-1)?.command).toContain("--yolo")
    expect(stated.persisted.at(-1)?.command).not.toContain("--no-yolo")

    const safe = deps()
    await adoptClaudeSessionUnlocked(options(), safe)
    expect(safe.persisted.at(-1)?.command).toContain("--no-yolo")
    expect(safe.persisted.at(-1)?.command).not.toContain("--yolo")
  })
})

describe("adoptClaudeSession refusals", () => {
  test("refuses a runtime session nothing on this machine binds to the cwd", async () => {
    const outcome = await adoptClaudeSessionUnlocked(
      options({ runtimeSessionId: "ccs-someone-else", cwd: CWD }),
      deps({ links: () => [] })
    )

    expect(outcome.status).toBe("refused identity mismatch")
    expect(outcome.detail).toContain(`derives ${RUNTIME}`)
  })

  test("refuses when the pane in the cwd is running a different runtime session", async () => {
    const stranger = pane({
      startCommand: COMMAND.replace(RUNTIME, "ccs-stranger"),
    })
    const outcome = await adoptClaudeSessionUnlocked(
      options(),
      deps({ panes: () => [stranger], links: () => [link()] })
    )

    expect(outcome.status).toBe("refused identity mismatch")
    expect(outcome.detail).toContain("ccs-stranger")
  })

  test("refuses when the attesting sources disagree about the instance id", async () => {
    const outcome = await adoptClaudeSessionUnlocked(
      options(),
      deps({ links: () => [link({ instanceId: "cc-elsewhere" })], inventory: () => [agent()] })
    )

    expect(outcome.status).toBe("refused identity mismatch")
    expect(outcome.detail).toContain("instance id disagreement")
  })

  test("refuses a root stream the harness link does not bind", async () => {
    const outcome = await adoptClaudeSessionUnlocked(options({ rootStreamId: "stream_other" }), deps())

    expect(outcome).toMatchObject({ status: "refused identity mismatch" })
    expect(outcome.detail).toContain(ROOT)
  })

  test("refuses when the sources disagree about the working directory", async () => {
    const outcome = await adoptClaudeSessionUnlocked(options({ cwd: "/Users/me/dev/other" }), deps())

    expect(outcome.status).toBe("refused identity mismatch")
    expect(outcome.detail).toContain("sources disagree")
  })

  test("refuses a cold takeover with no transcript on disk", async () => {
    const outcome = await adoptClaudeSessionUnlocked(options(), deps({ disk: disk({ list: () => [] }) }))

    expect(outcome.status).toBe("refused missing transcript")
    expect(outcome.detail).toContain("that a live process is not already holding")
  })

  test("refuses a pinned transcript that does not exist", async () => {
    const outcome = await adoptClaudeSessionUnlocked(
      options({ claudeSessionId: "123e4567-e89b-42d3-a456-426614174000" }),
      deps()
    )

    expect(outcome.status).toBe("refused missing transcript")
  })

  test("refuses to take over while a paneless Claude still runs in the cwd", async () => {
    const live = disk({
      list: (path) => (path.endsWith("sessions") ? ["34341.json"] : [`${NATIVE}.jsonl`]),
      read: () =>
        JSON.stringify({ pid: 34341, sessionId: NATIVE, cwd: CWD, procStart: START, name: "slopenv", status: "idle" }),
      processStart: () => START,
      alive: () => true,
    })
    const dependencies = deps({ disk: live })
    const outcome = await adoptClaudeSessionUnlocked(options(), dependencies)

    expect(outcome.status).toBe("refused live without pane")
    expect(outcome.detail).toContain("34341")
    expect(dependencies.launches).toEqual([])

    // --force waives the refusal to launch, NOT the rule that two Claudes never
    // share one conversation: the survivor holds the only transcript here.
    const forced = deps({ disk: live })
    const forcedOutcome = await adoptClaudeSessionUnlocked(options({ force: true }), forced)
    expect(forcedOutcome.status).toBe("refused missing transcript")
    expect(forced.launches).toEqual([])

    // With an unheld transcript to fall back to, --force takes over that one.
    const OTHER = "123e4567-e89b-42d3-a456-426614174000"
    const spare = deps({
      disk: disk({
        list: (path) => (path.endsWith("sessions") ? ["34341.json"] : [`${NATIVE}.jsonl`, `${OTHER}.jsonl`]),
        read: () =>
          JSON.stringify({
            pid: 34341,
            sessionId: NATIVE,
            cwd: CWD,
            procStart: START,
            name: "slopenv",
            status: "idle",
          }),
        processStart: () => START,
        alive: () => true,
        modified: (path) => (path.includes(NATIVE) ? 9_000 : 2_000),
      }),
    })
    expect((await adoptClaudeSessionUnlocked(options({ force: true }), spare)).status).toBe("taken over")
    expect(spare.launches).toMatchObject([{ resumeSessionId: OTHER }])
  })

  test("refuses an archived scratchpad before writing or launching anything", async () => {
    const dependencies = deps({ scratchpadStatus: async () => "archived" })
    const outcome = await adoptClaudeSessionUnlocked(options(), dependencies)

    expect(outcome).toEqual({ status: "refused archived", detail: ROOT })
    expect(dependencies.preflights).toEqual([])
    expect(dependencies.persisted).toEqual([])
    expect(dependencies.launches).toEqual([])
  })

  test("refuses an inaccessible scratchpad", async () => {
    const outcome = await adoptClaudeSessionUnlocked(options(), deps({ scratchpadStatus: async () => "inaccessible" }))

    expect(outcome.status).toBe("refused inaccessible")
  })

  test("refuses when the derived name belongs to a different session", async () => {
    const outcome = await adoptClaudeSessionUnlocked(
      options(),
      deps({ inventory: () => [agent({ id: "claude-stranger", runtimeSessionId: "ccs-stranger" })] })
    )

    expect(outcome.status).toBe("refused ambiguous")
    expect(outcome.detail).toContain("--name")
  })

  test("refuses an inventory row bound to a different scratchpad", async () => {
    const outcome = await adoptClaudeSessionUnlocked(
      options(),
      deps({ inventory: () => [agent({ scratchpadUrl: "https://app.threa.io/w/ws_one/s/stream_elsewhere" })] })
    )

    expect(outcome.status).toBe("refused identity mismatch")
    expect(outcome.detail).toContain("stream_elsewhere")
  })

  test("refuses an inventory row whose scratchpad names another workspace", async () => {
    const outcome = await adoptClaudeSessionUnlocked(
      options(),
      deps({ inventory: () => [agent({ scratchpadUrl: `https://app.threa.io/w/ws_wrong/s/${ROOT}` })] })
    )

    expect(outcome.status).toBe("refused identity mismatch")
    expect(outcome.detail).toContain("ws_wrong")
  })

  test("refuses without Threa credentials", async () => {
    const outcome = await adoptClaudeSessionUnlocked(options(), deps({ claudeConfig: () => ({}) }))

    expect(outcome.status).toBe("refused missing credentials")
  })

  test("refuses a cwd that is not a directory", async () => {
    const outcome = await adoptClaudeSessionUnlocked(options(), deps({ isDirectory: () => false }))

    expect(outcome.status).toBe("refused missing cwd")
  })

  test("refuses when no source names a working directory", async () => {
    const outcome = await adoptClaudeSessionUnlocked(options(), deps({ links: () => [] }))

    expect(outcome).toMatchObject({ status: "refused missing cwd" })
    expect(outcome.detail).toContain("no --cwd")
  })

  test("never launches when the preflight links a different root", async () => {
    const dependencies = deps({
      preflight: async () => ({ status: "mismatch", rootStreamId: "stream_replacement", expectedRootStreamId: ROOT }),
    })
    const outcome = await adoptClaudeSessionUnlocked(options(), dependencies)

    expect(outcome.status).toBe("refused identity mismatch")
    expect(outcome.detail).toContain("stream_replacement")
    expect(dependencies.launches).toEqual([])
    expect(dependencies.persisted).toEqual([])
  })
})

describe("boot dialogs", () => {
  test("adoption records the session online only after the launch settles them", async () => {
    const order: string[] = []
    const dependencies = deps({
      launch: async () => {
        order.push("boot")
        return {
          tmuxSession: "1",
          tmuxWindow: "slopenv",
          tmuxWindowId: "@300",
          tmuxPaneId: "%301",
          output: "❯ ",
        }
      },
      persist: (record) => void order.push(`persist:${record.status}`),
    })
    await adoptClaudeSessionUnlocked(options(), dependencies)

    expect(order).toEqual(["boot", "persist:online"])
  })

  test("the takeover's boot loop clears the development-channel warning then stops at the idle prompt", async () => {
    const screens = [
      "Do you trust the files in this folder?\n❯ 1. Yes\nEnter to confirm",
      "WARNING: development channels\n❯ 1. Continue\nEnter to continue",
      "\n❯ \n",
    ]
    const keys: string[][] = []
    let frame = 0
    await acceptClaudeBootPrompts("%301", {
      capture: () => screens[Math.min(frame++, screens.length - 1)]!,
      keys: (_pane, sent) => void keys.push(sent),
      sleep: async () => undefined,
    })

    expect(keys).toEqual([["Enter"], ["Enter"]])
  })
})

describe("takeover launch command", () => {
  test("is the managed shape reconnect can parse, resuming the recovered conversation", () => {
    const command = claudeLaunchCommand(
      claudeLaunchArgs({
        claudeBin: "/opt/claude",
        name: "slopenv",
        channel: "threa-channel",
        mcpConfig: "/tmp/threa.json",
        resumeSessionId: NATIVE,
      }),
      IDENTITY,
      {},
      "wait",
      "error",
      ROOT
    )

    // The original hand-started launch (`--name slopenv`) is NOT parseable by
    // the strict parser, which is why `reconnect` could never touch it. A taken
    // over session is, so it stays reconnectable from then on.
    expect(parseClaudeLaunch(command)).toMatchObject({
      executable: "/opt/claude",
      name: "threa.slopenv",
      resumeSessionId: NATIVE,
      channel: "threa-channel",
      mcpConfig: "/tmp/threa.json",
      skipPermissions: true,
    })
    expect(command).toContain("THREA_COLD_START_IF_ARCHIVED=wait")
    expect(command).toContain("THREA_COLD_START_IF_MISSING=error")
    expect(command).toContain(`THREA_EXPECTED_ROOT_STREAM_ID=${ROOT}`)
    expect(parseClaudeLaunch(COMMAND)).toBeUndefined()
  })

  test("--no-yolo drops the permission bypass", () => {
    const args = claudeLaunchArgs({
      claudeBin: "/opt/claude",
      name: "slopenv",
      channel: "threa-channel",
      mcpConfig: "/tmp/threa.json",
      noYolo: true,
      resumeSessionId: NATIVE,
    })

    expect(args).not.toContain("--dangerously-skip-permissions")
    expect(args.slice(0, 3)).toEqual(["/opt/claude", "--resume", NATIVE])
  })
})

describe("claude disk discovery", () => {
  test("takes the newest transcript and honours an explicit pin", () => {
    const files = disk({
      list: () => [`${NATIVE}.jsonl`, "123e4567-e89b-42d3-a456-426614174000.jsonl", "notes.txt"],
      modified: (path) => (path.includes(NATIVE) ? 2_000 : 9_000),
      exists: () => true,
    })

    expect(resolveClaudeTranscript(CWD, undefined, files).sessionId).toBe("123e4567-e89b-42d3-a456-426614174000")
    expect(resolveClaudeTranscript(CWD, NATIVE, files).sessionId).toBe(NATIVE)
    expect(() => resolveClaudeTranscript(CWD, "not-a-uuid", files)).toThrow("not a Claude session UUID")
  })

  test("a revival resumes the newest transcript no live process is holding", () => {
    const OTHER = "123e4567-e89b-42d3-a456-426614174000"
    const held = JSON.stringify({
      pid: 34341,
      sessionId: NATIVE,
      cwd: CWD,
      procStart: START,
      name: "slopenv",
      status: "idle",
    })
    const files = (live: boolean) =>
      disk({
        list: (path) => (path.endsWith("sessions") ? ["34341.json"] : [`${NATIVE}.jsonl`, `${OTHER}.jsonl`]),
        read: () => held,
        processStart: () => (live ? START : undefined),
        alive: () => live,
        modified: (path) => (path.includes(NATIVE) ? 9_000 : 2_000),
      })

    // Nothing alive: the newest transcript wins.
    expect(resumableClaudeTranscript(CWD, files(false))?.sessionId).toBe(NATIVE)
    // Its owner survived: fall through rather than put two Claudes on it.
    expect(resumableClaudeTranscript(CWD, files(true))?.sessionId).toBe(OTHER)
  })

  test("a worktree with no transcript resumes nothing instead of failing", () => {
    expect(resumableClaudeTranscript(CWD, disk({ list: () => [] }))).toBeUndefined()
    expect(
      resumableClaudeTranscript(
        CWD,
        disk({
          canonical: () => {
            throw new Error("gone")
          },
        })
      )
    ).toBeUndefined()
  })

  test("a registry entry whose process generation moved on is not live", () => {
    const row = JSON.stringify({
      pid: 34341,
      sessionId: NATIVE,
      cwd: CWD,
      procStart: START,
      name: "slopenv",
      status: "idle",
    })
    const base = {
      list: (path: string) => (path.endsWith("sessions") ? ["34341.json"] : []),
      read: () => row,
      alive: () => true,
    }

    expect(findLiveClaudeSessions(CWD, disk({ ...base, processStart: () => START }))).toHaveLength(1)
    expect(findLiveClaudeSessions(CWD, disk({ ...base, processStart: () => "Wed Jul 29 10:00:00 2026" }))).toEqual([])
    expect(findLiveClaudeSessions("/Users/me/dev/other", disk({ ...base, processStart: () => START }))).toEqual([])
    // A dead pid is dead whatever the registry says.
    expect(findLiveClaudeSessions(CWD, disk({ ...base, alive: () => false, processStart: () => START }))).toEqual([])
    // `ps` cannot distinguish "no such pid" from "ps failed", so an
    // indeterminate start time must NOT read as dead — one bad `ps` would
    // otherwise hide a live Claude from the occupied guard and the held-
    // transcript filter at the same instant.
    expect(findLiveClaudeSessions(CWD, disk({ ...base, processStart: () => undefined }))).toHaveLength(1)
  })
})

describe("parseAdopt", () => {
  test("requires an explicit target and root stream", () => {
    expect(() => parseAdopt([])).toThrow("adopt requires a runtime session id")
    expect(() => parseAdopt([RUNTIME])).toThrow("adopt requires --root-stream-id")
    expect(() => parseAdopt([RUNTIME, "--root-stream-id", ROOT, "--wat"])).toThrow("unexpected adopt argument: --wat")
  })

  test("parses the optional identifiers", () => {
    expect(
      parseAdopt([RUNTIME, "--root-stream-id", ROOT, "--cwd", CWD, "--name", "slop", "--dry-run", "--force"])
    ).toEqual({
      runtimeSessionId: RUNTIME,
      rootStreamId: ROOT,
      cwd: CWD,
      name: "slop",
      claudeSessionId: undefined,
      tmux: undefined,
      dryRun: true,
      force: true,
      noYolo: undefined,
      yolo: undefined,
    })
    expect(parseAdopt([RUNTIME, "--root-stream-id", ROOT, "--no-yolo"])).toMatchObject({ noYolo: true })
  })
})
