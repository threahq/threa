import { describe, expect, spyOn, test } from "bun:test"
import type { CommandClaim, HarnessLink } from "@threahq/harness-client"
import { parseDone } from "./cli"
import { doneAgent, type DoneDeps } from "./done"
import type { LocalTmuxPane } from "./discovery"
import { DEFAULT_PROFILE } from "./profiles"
import type { ManagedAgent } from "./types"

const AGENT: ManagedAgent = {
  id: "claude-1",
  name: "fix-sidebar",
  runtime: "claude",
  status: "online",
  worktree: "/repo/fix-sidebar",
  instanceId: "cc-sidebar",
  runtimeSessionId: "ccs-sidebar",
  command: [],
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z",
}

/** The `/done` command the pane claimed before harnessd took it over. */
const CLAIM: CommandClaim = {
  runtime: "claude",
  workspaceId: "ws_1",
  invocationId: "binv_done",
  instanceId: "cc-sidebar",
  claimToken: "claim-secret",
}

/** The command chip as harnessd drove it: every step, then completed or failed with the reason. */
const DONE_REQUEST = { ref: "fix-sidebar", rootStreamId: "stream_root", claimFile: "/tmp/claim.json" }

const LINK: HarnessLink = {
  runtimeKind: "claude-code-channel",
  runtimeSessionId: "ccs-sidebar",
  instanceId: "cc-sidebar",
  rootStreamId: "stream_root",
  worktree: "/repo/fix-sidebar",
  pid: 4242,
  updatedAt: "2026-08-10T00:00:00.000Z",
}

const PANE: LocalTmuxPane = {
  sessionName: "threa-agents",
  windowName: "fix-sidebar",
  windowId: "@7",
  paneId: "%9",
  panePid: 4242,
  cwd: "/repo/fix-sidebar",
  // A launch the resolver can tie back to the record's runtime session.
  startCommand:
    "env THREA_RUNTIME_SESSION_ID=ccs-sidebar claude --dangerously-load-development-channels server:threa-channel",
}

interface Recorded {
  calls: string[]
  logged: string[]
  persisted: ManagedAgent[]
}

function makeDoneDeps(
  options: {
    panes?: LocalTmuxPane[]
    claudePids?: number[]
    worktreeExists?: boolean
    teardown?: { ok: boolean; reason?: string }
    windDownResult?: { pushed: boolean; removed: boolean; reason?: string }
    endSessionError?: Error
  } = {}
): { deps: DoneDeps; recorded: Recorded } {
  const recorded: Recorded = { calls: [], logged: [], persisted: [] }
  const panes = options.panes ?? [PANE]
  const teardownResult = options.teardown ?? { ok: true }
  const windDownResult = options.windDownResult ?? { pushed: true, removed: true }
  const deps: DoneDeps = {
    findAgent: () => AGENT,
    links: () => [LINK],
    panes: () => panes,
    identities: () => [],
    claudeProcessesIn: () => options.claudePids ?? [],
    pathExists: () => options.worktreeExists ?? true,
    canonicalPath: (path) => path,
    profileFor: () => DEFAULT_PROFILE,
    teardown: (cwd) => {
      recorded.calls.push(`teardown:${cwd}`)
      return teardownResult
    },
    killWindow: (windowId) => void recorded.calls.push(`kill:${windowId}`),
    awaitExit: async (pid) => void recorded.calls.push(`awaitExit:${pid}`),
    windDown: (cwd) => {
      recorded.calls.push(`windDown:${cwd}`)
      return windDownResult
    },
    forgetLink: (id) => void recorded.calls.push(`forgetLink:${id}`),
    forgetIdentities: (worktree) => {
      recorded.calls.push(`forgetIdentities:${worktree}`)
      return ["ccs-sidebar"]
    },
    log: (message) => void recorded.logged.push(message),
    lock: async () => {
      recorded.calls.push("lock")
      return () => void recorded.calls.push("release")
    },
    persist: (agent) => {
      recorded.calls.push(`persist:${agent.status}`)
      recorded.persisted.push(agent)
    },
    endSession: async (identity) => {
      recorded.calls.push(`endSession:except=${identity.exceptInvocationId}`)
      if (options.endSessionError) throw options.endSessionError
    },
    readClaim: (path) => {
      recorded.calls.push(`readClaim:${path}`)
      return CLAIM
    },
    commandReporter: (claim) => {
      recorded.calls.push(`reporter:${claim.invocationId}`)
      return {
        progress: async (step) => void recorded.calls.push(`progress:${step}`),
        complete: async () => void recorded.calls.push("complete"),
        fail: async (message) => void recorded.calls.push(`fail:${message}`),
        stop: () => void recorded.calls.push("stop"),
      }
    },
  }
  return { deps, recorded }
}

describe("doneAgent", () => {
  test("drives the handed-over /done command: steps at each stage, the session ended around it, then completed", async () => {
    const { deps, recorded } = makeDoneDeps()

    await doneAgent(DONE_REQUEST, deps)

    expect(recorded.calls).toEqual([
      "readClaim:/tmp/claim.json",
      "reporter:binv_done",
      "lock",
      "progress:Committing, pushing and removing the worktree",
      "teardown:/repo/fix-sidebar",
      "kill:@7",
      "awaitExit:4242",
      "windDown:/repo/fix-sidebar",
      "forgetLink:ccs-sidebar",
      "forgetIdentities:/repo/fix-sidebar",
      "progress:Ending the session link",
      "endSession:except=binv_done",
      "persist:stopped",
      "complete",
      "release",
      "stop",
    ])
    expect(recorded.persisted).toEqual([{ ...AGENT, status: "stopped", updatedAt: recorded.persisted[0]?.updatedAt }])
  })

  test("no live pane skips the kill but still winds down and ends the link", async () => {
    const { deps, recorded } = makeDoneDeps({ panes: [] })

    await doneAgent(DONE_REQUEST, deps)

    expect(recorded.calls).toEqual([
      "readClaim:/tmp/claim.json",
      "reporter:binv_done",
      "lock",
      "progress:Committing, pushing and removing the worktree",
      "teardown:/repo/fix-sidebar",
      "windDown:/repo/fix-sidebar",
      "forgetLink:ccs-sidebar",
      "forgetIdentities:/repo/fix-sidebar",
      "progress:Ending the session link",
      "endSession:except=binv_done",
      "persist:stopped",
      "complete",
      "release",
      "stop",
    ])
  })

  test("a done typed at the terminal has no command to drive and ends the session with nothing spared", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {})
    try {
      const { deps, recorded } = makeDoneDeps({ panes: [] })

      await doneAgent({ ref: "fix-sidebar", rootStreamId: "stream_root" }, deps)

      expect(recorded.calls).toEqual([
        "lock",
        "teardown:/repo/fix-sidebar",
        "windDown:/repo/fix-sidebar",
        "forgetLink:ccs-sidebar",
        "forgetIdentities:/repo/fix-sidebar",
        "endSession:except=undefined",
        "persist:stopped",
        "release",
      ])
      expect(log.mock.calls.map((call) => call[0])).toEqual([
        "done\tCommitting, pushing and removing the worktree",
        "done\tEnding the session link",
        "done\tfix-sidebar\tWorktree removed\tlink ended",
      ])
    } finally {
      log.mockRestore()
    }
  })

  test("refuses a worktree where a paneless Claude is still running, and fails the command with that reason", async () => {
    // The reaper's veto: what `done` force-removes is a directory, and a live
    // Claude in it is fatal whichever record asked for the wind-down.
    const { deps, recorded } = makeDoneDeps({ panes: [], claudePids: [9911] })

    await expect(doneAgent(DONE_REQUEST, deps)).rejects.toThrow(
      "fix-sidebar: Claude is still running in /repo/fix-sidebar with no pane (pid 9911)"
    )

    expect(recorded.calls).toEqual([
      "readClaim:/tmp/claim.json",
      "reporter:binv_done",
      "lock",
      "progress:Committing, pushing and removing the worktree",
      "release",
      "fail:fix-sidebar: Claude is still running in /repo/fix-sidebar with no pane (pid 9911)",
      "stop",
    ])
    expect(recorded.persisted).toEqual([])
  })

  test("a worktree removed by hand still kills the window, clears the records, and ends the session", async () => {
    const { deps, recorded } = makeDoneDeps({ worktreeExists: false })

    await doneAgent(DONE_REQUEST, deps)

    expect(recorded.calls).toEqual([
      "readClaim:/tmp/claim.json",
      "reporter:binv_done",
      "lock",
      "progress:Committing, pushing and removing the worktree",
      "kill:@7",
      "awaitExit:4242",
      "forgetLink:ccs-sidebar",
      "forgetIdentities:/repo/fix-sidebar",
      "progress:Worktree already gone",
      "progress:Ending the session link",
      "endSession:except=binv_done",
      "persist:stopped",
      "complete",
      "release",
      "stop",
    ])
  })

  test("a teardown failure dies with nothing killed, nothing ended, and the row unchanged", async () => {
    const { deps, recorded } = makeDoneDeps({ teardown: { ok: false, reason: "lint failed" } })

    await expect(doneAgent(DONE_REQUEST, deps)).rejects.toThrow(
      "fix-sidebar: teardown failed, nothing removed: lint failed"
    )

    expect(recorded.calls).toEqual([
      "readClaim:/tmp/claim.json",
      "reporter:binv_done",
      "lock",
      "progress:Committing, pushing and removing the worktree",
      "teardown:/repo/fix-sidebar",
      "release",
      "fail:fix-sidebar: teardown failed, nothing removed: lint failed",
      "stop",
    ])
    expect(recorded.persisted).toEqual([])
  })

  test("a refused wind-down does not retire identities, still ends the session, still persists stopped, and reports the worktree left as a step", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {})
    try {
      const { deps, recorded } = makeDoneDeps({
        windDownResult: { pushed: false, removed: false, reason: "branch protected" },
      })

      await doneAgent(DONE_REQUEST, deps)

      expect(recorded.calls).toEqual([
        "readClaim:/tmp/claim.json",
        "reporter:binv_done",
        "lock",
        "progress:Committing, pushing and removing the worktree",
        "teardown:/repo/fix-sidebar",
        "kill:@7",
        "awaitExit:4242",
        "windDown:/repo/fix-sidebar",
        "forgetLink:ccs-sidebar",
        "progress:Worktree left: branch protected",
        "progress:Ending the session link",
        "endSession:except=binv_done",
        "persist:stopped",
        "complete",
        "release",
        "stop",
      ])
      expect(recorded.persisted).toEqual([{ ...AGENT, status: "stopped", updatedAt: recorded.persisted[0]?.updatedAt }])
      expect(log.mock.calls.at(-1)?.[0]).toBe("done\tfix-sidebar\tWorktree left: branch protected\tlink ended")
    } finally {
      log.mockRestore()
    }
  })

  test("an unresolved remote cleanup persists the stopped row with its exact retry identity and reports failure", async () => {
    const { deps, recorded } = makeDoneDeps({
      endSessionError: new Error("harnessd: remote cleanup unresolved: could not end runtime session: 404 not found"),
    })

    await expect(doneAgent(DONE_REQUEST, deps)).rejects.toThrow("remote cleanup unresolved")

    expect(recorded.calls).toEqual([
      "readClaim:/tmp/claim.json",
      "reporter:binv_done",
      "lock",
      "progress:Committing, pushing and removing the worktree",
      "teardown:/repo/fix-sidebar",
      "kill:@7",
      "awaitExit:4242",
      "windDown:/repo/fix-sidebar",
      "forgetLink:ccs-sidebar",
      "forgetIdentities:/repo/fix-sidebar",
      "progress:Ending the session link",
      "endSession:except=binv_done",
      "persist:stopped",
      "release",
      "fail:harnessd: remote cleanup unresolved: could not end runtime session: 404 not found",
      "stop",
    ])
    expect(recorded.persisted).toEqual([
      {
        ...AGENT,
        status: "stopped",
        instanceId: "cc-sidebar",
        runtimeSessionId: "ccs-sidebar",
        updatedAt: recorded.persisted[0]?.updatedAt,
      },
    ])
  })
  test("a competing same-runtime link vetoes every destructive cleanup step", async () => {
    const { deps, recorded } = makeDoneDeps()
    deps.links = () => [
      LINK,
      {
        ...LINK,
        instanceId: "cc-other",
        runtimeSessionId: "ccs-other",
      },
    ]

    await expect(doneAgent(DONE_REQUEST, deps)).rejects.toThrow("identity evidence for /repo/fix-sidebar disagrees")

    expect(recorded.calls).toEqual([
      "readClaim:/tmp/claim.json",
      "reporter:binv_done",
      "lock",
      "progress:Committing, pushing and removing the worktree",
      "release",
      "fail:fix-sidebar: identity evidence for /repo/fix-sidebar disagrees: ccs-sidebar, ccs-other",
      "stop",
    ])
    expect(recorded.persisted).toEqual([])
  })

  test("refuses a session linked to another scratchpad, failing the command that asked", async () => {
    // Nothing stops the link from moving while `done` waits on the lock; the
    // wind-down belongs to whoever is sitting in the scratchpad now.
    const { deps, recorded } = makeDoneDeps()

    await expect(doneAgent({ ...DONE_REQUEST, rootStreamId: "stream_other" }, deps)).rejects.toThrow(
      "fix-sidebar: linked to stream_root, not stream_other"
    )

    expect(recorded.calls).toEqual([
      "readClaim:/tmp/claim.json",
      "reporter:binv_done",
      "lock",
      "release",
      "fail:fix-sidebar: linked to stream_root, not stream_other",
      "stop",
    ])
    expect(recorded.persisted).toEqual([])
  })

  test("an unlinked agent fails the command, not only the daemon log", async () => {
    // harnessd runs detached with its output in a log file nobody is reading, so
    // a failure this early has to reach the command chip or it reaches no one.
    const { deps, recorded } = makeDoneDeps()
    deps.findAgent = () => ({ ...AGENT, worktree: undefined })

    await expect(doneAgent(DONE_REQUEST, deps)).rejects.toThrow("done needs a linked managed session")

    expect(recorded.calls).toEqual([
      "readClaim:/tmp/claim.json",
      "reporter:binv_done",
      "fail:done needs a linked managed session",
      "stop",
    ])
  })

  test("an unreadable claim file drives nothing: the wind-down never starts", async () => {
    const { deps, recorded } = makeDoneDeps()
    deps.readClaim = (path) => {
      throw new Error(`claim file ${path} is missing claimToken`)
    }

    await expect(doneAgent(DONE_REQUEST, deps)).rejects.toThrow("missing claimToken")

    expect(recorded.calls).toEqual([])
  })
})

describe("parseDone", () => {
  test("requires a ref and the root the command was typed in", () => {
    expect(parseDone(["fix-sidebar", "--root-stream-id", "stream_one"])).toEqual({
      ref: "fix-sidebar",
      rootStreamId: "stream_one",
    })
    expect(parseDone(["fix-sidebar", "--root-stream-id", "stream_one", "--claim-file", "/tmp/claim.json"])).toEqual({
      ref: "fix-sidebar",
      rootStreamId: "stream_one",
      claimFile: "/tmp/claim.json",
    })
    expect(() => parseDone(["fix-sidebar"])).toThrow("requires --root-stream-id")
    expect(() => parseDone(["--root-stream-id", "stream_one"])).toThrow("requires an agent id")
    expect(() => parseDone(["fix-sidebar", "--root-stream-id", "stream_one", "--force"])).toThrow("unexpected")
  })
})
