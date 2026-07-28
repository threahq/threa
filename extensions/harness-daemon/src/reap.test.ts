import { describe, expect, test } from "bun:test"
import type { HarnessLink } from "@threa/bot-runtime-client"
import { OBSERVER_WARMUP_MS, REAP_AFTER_MS, reapArchivedWorktrees, type ReapDeps } from "./reap"
import type { LocalTmuxPane } from "./discovery"

const NOW = Date.parse("2026-07-27T12:00:00.000Z")
const WORKTREE = "/repo/threa.feature"

function link(overrides: Partial<HarnessLink> = {}): HarnessLink {
  return {
    runtimeKind: "claude-code-channel",
    runtimeSessionId: "ccs-abc",
    instanceId: "cc-abc",
    rootStreamId: "stream_root",
    worktree: WORKTREE,
    pid: 4242,
    updatedAt: "2026-07-27T10:00:00.000Z",
    ...overrides,
  }
}

function pane(overrides: Partial<LocalTmuxPane> = {}): LocalTmuxPane {
  return {
    sessionName: "threa-agents",
    windowName: "feature",
    windowId: "@7",
    paneId: "%8",
    panePid: 4242,
    cwd: WORKTREE,
    // A launch the resolver can tie back to the record's runtime session.
    startCommand:
      "env THREA_RUNTIME_SESSION_ID=ccs-abc claude --dangerously-load-development-channels server:threa-channel",
    ...overrides,
  }
}

interface Recorded {
  woundDown: string[]
  killed: string[]
  forgotten: string[]
}

function makeDeps(overrides: Partial<ReapDeps> = {}): { deps: ReapDeps; recorded: Recorded } {
  const recorded: Recorded = { woundDown: [], killed: [], forgotten: [] }
  const deps: ReapDeps = {
    links: () => [link()],
    panes: () => [pane()],
    claudeProcessesIn: () => [],
    canonicalPath: (path) => path,
    scratchpadStatus: async () => "archived",
    // Long enough ago that the owning runtime has had its full chance.
    archivedAt: async () => new Date(NOW - REAP_AFTER_MS - 60_000).toISOString(),
    pathExists: () => true,
    windDown: (cwd) => {
      recorded.woundDown.push(cwd)
      return { pushed: true, removed: true }
    },
    killWindow: (windowId) => void recorded.killed.push(windowId),
    forgetLink: (id) => void recorded.forgotten.push(id),
    now: () => NOW,
    log: () => {},
    ...overrides,
  }
  return { deps, recorded }
}

describe("reapArchivedWorktrees", () => {
  test("reaps a worktree whose scratchpad was archived past the margin", async () => {
    const { deps, recorded } = makeDeps()

    const [outcome] = await reapArchivedWorktrees(deps)

    expect(outcome).toMatchObject({ status: "reaped", worktree: WORKTREE })
    expect(recorded).toEqual({ woundDown: [WORKTREE], killed: ["@7"], forgotten: ["ccs-abc"] })
  })

  test("leaves the owning runtime its full detection window plus grace", async () => {
    // The runtime can take a socket-backstop poll to notice, then holds its own
    // grace. Reaping inside that would steal an unarchive from a live runtime.
    const { deps, recorded } = makeDeps({
      archivedAt: async () => new Date(NOW - REAP_AFTER_MS + 60_000).toISOString(),
    })

    const [outcome] = await reapArchivedWorktrees(deps)

    expect(outcome.status).toBe("skipped grace")
    expect(recorded.woundDown).toEqual([])
  })

  test("never touches an active scratchpad", async () => {
    const { deps, recorded } = makeDeps({ scratchpadStatus: async () => "active" })

    const [outcome] = await reapArchivedWorktrees(deps)

    expect(outcome.status).toBe("skipped active")
    expect(recorded).toEqual({ woundDown: [], killed: [], forgotten: [] })
  })

  test("an unreadable scratchpad is never grounds to delete", async () => {
    // 403/404 is indistinguishable from a missing API-key scope.
    for (const status of ["inaccessible", "unavailable"] as const) {
      const { deps, recorded } = makeDeps({ scratchpadStatus: async () => status })

      const [outcome] = await reapArchivedWorktrees(deps)

      expect(outcome.status).toBe(`skipped ${status}`)
      expect(recorded.woundDown).toEqual([])
    }
  })

  test("refuses to guess when two panes share the worktree", async () => {
    const { deps, recorded } = makeDeps({
      panes: () => [pane(), pane({ windowId: "@9", paneId: "%10" })],
    })

    const [outcome] = await reapArchivedWorktrees(deps)

    expect(["skipped ambiguous", "skipped occupied"]).toContain(outcome.status)
    expect(recorded).toEqual({ woundDown: [], killed: [], forgotten: [] })
  })

  test("refuses a worktree now occupied by a session the record does not own", async () => {
    // Worktree paths are stable per feature name and get reused. A record left
    // behind by a crashed runtime names a directory a different, LIVE session
    // now occupies; reaping on it would push and delete that session's work
    // under the label "scratchpad archived", and kill its window.
    const { deps, recorded } = makeDeps({
      panes: () => [
        pane({
          startCommand:
            "env THREA_RUNTIME_SESSION_ID=ccs-somebody-else claude --dangerously-load-development-channels server:threa-channel",
        }),
      ],
    })

    const [outcome] = await reapArchivedWorktrees(deps)

    expect(outcome.status).toBe("skipped occupied")
    expect(recorded).toEqual({ woundDown: [], killed: [], forgotten: [] })
  })

  test("refuses a worktree where a paneless Claude is still running", async () => {
    // A Claude detached from tmux, or whose window was killed while it kept
    // running, leaves no pane and is very much alive. Reaping on the pane scan
    // alone would push a half-done tree and delete the directory out from
    // under it.
    const { deps, recorded } = makeDeps({ panes: () => [], claudeProcessesIn: () => [9911] })

    const [outcome] = await reapArchivedWorktrees(deps)

    expect(outcome.status).toBe("skipped occupied")
    expect(outcome.detail).toContain("9911")
    expect(recorded).toEqual({ woundDown: [], killed: [], forgotten: [] })
  })

  test("still reaps a live Claude the record's own pane accounts for", async () => {
    // The ordinary case: the owning runtime is still up when the reaper runs.
    // Its pid IS the pane's pid, so the process-table veto must not fire.
    const { deps, recorded } = makeDeps({ claudeProcessesIn: () => [4242] })

    const [outcome] = await reapArchivedWorktrees(deps)

    expect(outcome.status).toBe("reaped")
    expect(recorded).toEqual({ woundDown: [WORKTREE], killed: ["@7"], forgotten: ["ccs-abc"] })
  })

  test("refuses when a second, paneless Claude shares the record's worktree", async () => {
    // Killing the record's window does not stop the other one.
    const { deps, recorded } = makeDeps({ claudeProcessesIn: () => [4242, 5150] })

    const [outcome] = await reapArchivedWorktrees(deps)

    expect(outcome.status).toBe("skipped occupied")
    expect(outcome.detail).toContain("5150")
    expect(recorded).toEqual({ woundDown: [], killed: [], forgotten: [] })
  })

  test("an occupying pane is still found when the record stored a non-canonical path", async () => {
    // Link records store a raw `process.cwd()`; tmux reports the resolved path.
    // Comparing them raw reads an occupied worktree as empty — the one
    // misreading that ends in a force-remove.
    const { deps, recorded } = makeDeps({
      links: () => [link({ worktree: `/tmp${WORKTREE}` })],
      panes: () => [
        pane({
          startCommand:
            "env THREA_RUNTIME_SESSION_ID=ccs-somebody-else claude --dangerously-load-development-channels server:threa-channel",
        }),
      ],
      canonicalPath: (path) => (path.startsWith("/tmp") ? path.slice("/tmp".length) : path),
    })

    const [outcome] = await reapArchivedWorktrees(deps)

    expect(outcome.status).toBe("skipped occupied")
    expect(recorded).toEqual({ woundDown: [], killed: [], forgotten: [] })
  })

  test("the window is closed before the wind-down removes the directory under it", async () => {
    // The removal is synchronous now, and the pane's shell sits in the
    // worktree — killing after would be removing it out from under a live shell.
    const order: string[] = []
    const { deps } = makeDeps({
      killWindow: () => void order.push("kill"),
      windDown: () => {
        order.push("windDown")
        return { pushed: true, removed: true }
      },
    })

    await reapArchivedWorktrees(deps)

    expect(order).toEqual(["kill", "windDown"])
  })

  test("a freshly woken daemon gives runtimes their own detection window first", async () => {
    // archivedAt keeps accruing while the machine sleeps, but the runtime that
    // owns the worktree was asleep too and only starts its detection+grace on
    // wake. Reaping in that instant races a live runtime that never got a
    // chance.
    const { deps, recorded } = makeDeps({ observingSinceMs: NOW - OBSERVER_WARMUP_MS + 60_000 })

    const [outcome] = await reapArchivedWorktrees(deps)

    expect(outcome.status).toBe("skipped observer too young")
    expect(recorded).toEqual({ woundDown: [], killed: [], forgotten: [] })
  })

  test("an explicit run has no warmup gate — a human asking is the signal", async () => {
    const { deps, recorded } = makeDeps({ observingSinceMs: undefined })

    const [outcome] = await reapArchivedWorktrees(deps)

    expect(outcome.status).toBe("reaped")
    expect(recorded.woundDown).toEqual([WORKTREE])
  })

  test("a worktree already gone just drops the record", async () => {
    const { deps, recorded } = makeDeps({ pathExists: () => false })

    const [outcome] = await reapArchivedWorktrees(deps)

    expect(outcome.status).toBe("skipped worktree missing")
    expect(recorded).toEqual({ woundDown: [], killed: [], forgotten: ["ccs-abc"] })
  })

  test("a link with no live pane is still reaped — that is the offline case", async () => {
    // Archived while the machine slept and the runtime never came back: no
    // window to kill, but the worktree is exactly what needs cleaning up.
    const { deps, recorded } = makeDeps({ panes: () => [] })

    const [outcome] = await reapArchivedWorktrees(deps)

    expect(outcome.status).toBe("reaped")
    expect(recorded).toEqual({ woundDown: [WORKTREE], killed: [], forgotten: ["ccs-abc"] })
  })

  test("the window closes even when the cleanup refuses, and the worktree is left behind", async () => {
    const { deps, recorded } = makeDeps({
      windDown: (cwd) => {
        recorded.woundDown.push(cwd)
        return {
          pushed: false,
          removed: false,
          reason: "branch 'HEAD' is protected or detached — leaving everything as is",
        }
      },
    })

    const [outcome] = await reapArchivedWorktrees(deps)

    expect(outcome.status).toBe("reaped, worktree left")
    expect(outcome.detail).toContain("pushed=false")
    expect(recorded.killed).toEqual(["@7"])
  })

  test("dry run decides without touching anything", async () => {
    const { deps, recorded } = makeDeps()

    const [outcome] = await reapArchivedWorktrees(deps, true)

    expect(outcome.status).toBe("would reap")
    expect(recorded).toEqual({ woundDown: [], killed: [], forgotten: [] })
  })

  test("one failing link does not abort the sweep", async () => {
    const { deps, recorded } = makeDeps({
      links: () => [link({ runtimeSessionId: "boom", rootStreamId: "stream_boom" }), link({ runtimeSessionId: "ok" })],
      panes: () => [],
      archivedAt: async (streamId) => {
        if (streamId === "stream_boom") throw new Error("threa unreachable")
        return new Date(NOW - REAP_AFTER_MS - 60_000).toISOString()
      },
    })

    const outcomes = await reapArchivedWorktrees(deps)

    expect(outcomes.map((o) => o.status)).toEqual(["skipped unavailable", "reaped"])
    expect(recorded.woundDown).toEqual([WORKTREE])
  })

  test("a runtime that served its own grace is reaped on the next pass, not after the margin again", async () => {
    // The runtime watched the 5-minute grace expire and handed the worktree
    // over before exiting. Re-serving the 25-minute margin here would turn
    // ordinary cleanup from 5 minutes into 25.
    const { deps, recorded } = makeDeps({
      links: () => [link({ windDownRequestedAt: new Date(NOW - 1_000).toISOString() })],
      archivedAt: async () => new Date(NOW - 60_000).toISOString(),
      panes: () => [],
    })

    const [outcome] = await reapArchivedWorktrees(deps)

    expect(outcome).toMatchObject({ status: "reaped" })
    expect(recorded.woundDown).toEqual([WORKTREE])
  })

  test("a marked record needs no archivedAt at all", async () => {
    // The decision is the runtime's, already made; a Threa read that fails or
    // returns no archivedAt must not strand the worktree.
    const { deps, recorded } = makeDeps({
      links: () => [link({ windDownRequestedAt: new Date(NOW - 1_000).toISOString() })],
      archivedAt: async () => {
        throw new Error("archivedAt must not be consulted for a marked record")
      },
      panes: () => [],
    })

    const [outcome] = await reapArchivedWorktrees(deps)

    expect(outcome.status).toBe("reaped")
    expect(recorded.woundDown).toEqual([WORKTREE])
  })

  test("a marked record still defers to a scratchpad that came back", async () => {
    // Marked, then unarchived and revived before this pass ran. The mark is
    // stale; live server state wins.
    const { deps, recorded } = makeDeps({
      links: () => [link({ windDownRequestedAt: new Date(NOW - 1_000).toISOString() })],
      scratchpadStatus: async () => "active",
    })

    const [outcome] = await reapArchivedWorktrees(deps)

    expect(outcome.status).toBe("skipped active")
    expect(recorded).toEqual({ woundDown: [], killed: [], forgotten: [] })
  })

  test("the observer warmup holds back unmarked records only", async () => {
    // Warmup protects a runtime whose detection clock restarted on wake. A
    // runtime that already decided is not that runtime.
    const { deps, recorded } = makeDeps({
      observingSinceMs: NOW - OBSERVER_WARMUP_MS + 60_000,
      links: () => [
        link({ runtimeSessionId: "unmarked" }),
        link({ runtimeSessionId: "marked", windDownRequestedAt: new Date(NOW - 1_000).toISOString() }),
      ],
      panes: () => [],
    })

    const outcomes = await reapArchivedWorktrees(deps)

    expect(outcomes.map((o) => o.status)).toEqual(["skipped observer too young", "reaped"])
    expect(recorded.forgotten).toEqual(["marked"])
  })

  test("the margin outlasts a runtime's own detection plus grace", () => {
    // 15-min socket backstop + 2x the 5-min grace.
    expect(REAP_AFTER_MS).toBe(25 * 60 * 1000)
  })
})
