import { describe, expect, spyOn, test } from "bun:test"
import type { HarnessLink } from "@threahq/harness-client"
import { parseDone } from "./cli"
import { doneAgent, type DoneDeps, type SessionEnd } from "./done"
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

/** The thread the linked session lives in — where `/done` reports its outcome. */
const THREAD = "stream_thread"

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
    endSessionResult?: SessionEnd
  } = {}
): { deps: DoneDeps; recorded: Recorded } {
  const recorded: Recorded = { calls: [], logged: [], persisted: [] }
  const panes = options.panes ?? [PANE]
  const teardownResult = options.teardown ?? { ok: true }
  const windDownResult = options.windDownResult ?? { pushed: true, removed: true }
  const endSessionResult = options.endSessionResult ?? { status: "ended" as const, activeStreamId: THREAD }
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
    endSession: async () => {
      recorded.calls.push("endSession")
      return endSessionResult
    },
    postNotice: async (streamId, content) => void recorded.calls.push(`postNotice:${streamId}:${content}`),
  }
  return { deps, recorded }
}

describe("doneAgent", () => {
  test("kills the pane, waits for exit, winds down, forgets the link, retires identities, ends the session, persists stopped, and reports in the thread", async () => {
    const { deps, recorded } = makeDoneDeps()

    await doneAgent({ ref: "fix-sidebar", rootStreamId: "stream_root" }, deps)

    expect(recorded.calls).toEqual([
      "lock",
      "teardown:/repo/fix-sidebar",
      "kill:@7",
      "awaitExit:4242",
      "windDown:/repo/fix-sidebar",
      "forgetLink:ccs-sidebar",
      "forgetIdentities:/repo/fix-sidebar",
      "endSession",
      "persist:stopped",
      "postNotice:stream_thread:harnessd: done — worktree removed, link ended.",
      "release",
    ])
    expect(recorded.persisted).toEqual([{ ...AGENT, status: "stopped", updatedAt: recorded.persisted[0]?.updatedAt }])
  })

  test("no live pane skips the kill but still winds down and ends the link", async () => {
    const { deps, recorded } = makeDoneDeps({ panes: [] })

    await doneAgent({ ref: "fix-sidebar", rootStreamId: "stream_root" }, deps)

    expect(recorded.calls).toEqual([
      "lock",
      "teardown:/repo/fix-sidebar",
      "windDown:/repo/fix-sidebar",
      "forgetLink:ccs-sidebar",
      "forgetIdentities:/repo/fix-sidebar",
      "endSession",
      "persist:stopped",
      "postNotice:stream_thread:harnessd: done — worktree removed, link ended.",
      "release",
    ])
  })

  test("refuses a worktree where a paneless Claude is still running, and says so in the root stream", async () => {
    // The reaper's veto: what `done` force-removes is a directory, and a live
    // Claude in it is fatal whichever record asked for the wind-down.
    const { deps, recorded } = makeDoneDeps({ panes: [], claudePids: [9911] })

    await expect(doneAgent({ ref: "fix-sidebar", rootStreamId: "stream_root" }, deps)).rejects.toThrow(
      "fix-sidebar: Claude is still running in /repo/fix-sidebar with no pane (pid 9911)"
    )

    expect(recorded.calls).toEqual([
      "lock",
      "release",
      "postNotice:stream_root:harnessd: `/done` for `fix-sidebar` failed: fix-sidebar: Claude is still running in /repo/fix-sidebar with no pane (pid 9911)",
    ])
    expect(recorded.persisted).toEqual([])
  })

  test("a worktree removed by hand still kills the window, clears the records, and ends the session", async () => {
    const { deps, recorded } = makeDoneDeps({ worktreeExists: false })

    await doneAgent({ ref: "fix-sidebar", rootStreamId: "stream_root" }, deps)

    expect(recorded.calls).toEqual([
      "lock",
      "kill:@7",
      "awaitExit:4242",
      "forgetLink:ccs-sidebar",
      "forgetIdentities:/repo/fix-sidebar",
      "endSession",
      "persist:stopped",
      "postNotice:stream_thread:harnessd: done — worktree already gone, link ended.",
      "release",
    ])
  })

  test("a teardown failure dies with nothing killed, nothing ended, and the row unchanged", async () => {
    const { deps, recorded } = makeDoneDeps({ teardown: { ok: false, reason: "lint failed" } })

    await expect(doneAgent({ ref: "fix-sidebar", rootStreamId: "stream_root" }, deps)).rejects.toThrow(
      "fix-sidebar: teardown failed, nothing removed: lint failed"
    )

    expect(recorded.calls).toEqual([
      "lock",
      "teardown:/repo/fix-sidebar",
      "release",
      "postNotice:stream_root:harnessd: `/done` for `fix-sidebar` failed: fix-sidebar: teardown failed, nothing removed: lint failed",
    ])
    expect(recorded.persisted).toEqual([])
  })

  test("a refused wind-down does not retire identities, still ends the session, still persists stopped, and reports the worktree left", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {})
    try {
      const { deps, recorded } = makeDoneDeps({
        windDownResult: { pushed: false, removed: false, reason: "branch protected" },
      })

      await doneAgent({ ref: "fix-sidebar", rootStreamId: "stream_root" }, deps)

      expect(recorded.calls).toEqual([
        "lock",
        "teardown:/repo/fix-sidebar",
        "kill:@7",
        "awaitExit:4242",
        "windDown:/repo/fix-sidebar",
        "forgetLink:ccs-sidebar",
        "endSession",
        "persist:stopped",
        "postNotice:stream_thread:harnessd: done — worktree left: branch protected, link ended.",
        "release",
      ])
      expect(recorded.persisted).toEqual([{ ...AGENT, status: "stopped", updatedAt: recorded.persisted[0]?.updatedAt }])
      expect(log.mock.calls.at(-1)?.[0]).toBe("done\tfix-sidebar\tworktree left: branch protected\tlink ended")
    } finally {
      log.mockRestore()
    }
  })

  test("a 404 from endSession completes as already ended", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {})
    try {
      const { deps, recorded } = makeDoneDeps({ endSessionResult: { status: "not-found" } })

      await doneAgent({ ref: "fix-sidebar", rootStreamId: "stream_root" }, deps)

      expect(recorded.logged).toContain("fix-sidebar: link already ended")
      // An already-ended link names no thread, so the outcome falls back to the root.
      expect(recorded.calls).toContain("postNotice:stream_root:harnessd: done — worktree removed, link already ended.")
      expect(log.mock.calls.at(-1)?.[0]).toBe("done\tfix-sidebar\tworktree removed\tlink already ended")
    } finally {
      log.mockRestore()
    }
  })
  test("refuses a session linked to another scratchpad, and reports it where /done was typed", async () => {
    // Nothing stops the link from moving while `done` waits on the lock; the
    // wind-down belongs to whoever is sitting in the scratchpad now.
    const { deps, recorded } = makeDoneDeps()

    await expect(doneAgent({ ref: "fix-sidebar", rootStreamId: "stream_other" }, deps)).rejects.toThrow(
      "fix-sidebar: linked to stream_root, not stream_other"
    )

    expect(recorded.calls).toEqual([
      "lock",
      "release",
      "postNotice:stream_other:harnessd: `/done` for `fix-sidebar` failed: fix-sidebar: linked to stream_root, not stream_other",
    ])
    expect(recorded.persisted).toEqual([])
  })

  test("an unlinked agent is reported to the root, not only to the daemon log", async () => {
    // harnessd runs detached with its output in a log file nobody is reading, so
    // a failure this early has to reach the scratchpad or it reaches no one.
    const { deps, recorded } = makeDoneDeps()
    deps.findAgent = () => ({ ...AGENT, worktree: undefined })

    await expect(doneAgent({ ref: "fix-sidebar", rootStreamId: "stream_root" }, deps)).rejects.toThrow(
      "done needs a linked managed session"
    )

    expect(recorded.calls).toEqual([
      "postNotice:stream_root:harnessd: `/done` for `fix-sidebar` failed: done needs a linked managed session",
    ])
  })
})

describe("parseDone", () => {
  test("requires a ref and the root the command was typed in", () => {
    expect(parseDone(["fix-sidebar", "--root-stream-id", "stream_one"])).toEqual({
      ref: "fix-sidebar",
      rootStreamId: "stream_one",
    })
    expect(() => parseDone(["fix-sidebar"])).toThrow("requires --root-stream-id")
    expect(() => parseDone(["--root-stream-id", "stream_one"])).toThrow("requires an agent id")
    expect(() => parseDone(["fix-sidebar", "--root-stream-id", "stream_one", "--force"])).toThrow("unexpected")
  })
})
