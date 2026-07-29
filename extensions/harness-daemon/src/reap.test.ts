import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { HarnessLink } from "@threa/bot-runtime-client"
import { OBSERVER_WARMUP_MS, REAP_AFTER_MS, reapArchivedWorktrees, type ReapDeps } from "./reap"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LocalTmuxPane } from "./discovery"

// Every dep is injected, but a defaulted one would silently read the developer's
// real stores — which is how a green test can depend on what happens to be in
// ~/.threa/harnessd. Point them at an empty directory so a leak fails loudly.
const ISOLATED = ["THREA_HARNESSD_IDENTITIES_DIR", "THREA_HARNESS_LINKS_DIR", "THREA_HARNESSD_INVENTORY"] as const
const saved = new Map<string, string | undefined>()

beforeAll(() => {
  const root = mkdtempSync(join(tmpdir(), "harnessd-reap-"))
  for (const name of ISOLATED) {
    saved.set(name, process.env[name])
    process.env[name] = join(root, name.toLowerCase())
  }
})

afterAll(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

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
  awaited: number[]
  retired: string[]
}

function makeDeps(overrides: Partial<ReapDeps> = {}): { deps: ReapDeps; recorded: Recorded } {
  const recorded: Recorded = { woundDown: [], killed: [], forgotten: [], awaited: [], retired: [] }
  const deps: ReapDeps = {
    links: () => [link()],
    identities: () => [],
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
    awaitExit: async (pid) => void recorded.awaited.push(pid),
    forgetLink: (id) => void recorded.forgotten.push(id),
    forgetIdentities: (worktree) => {
      recorded.retired.push(worktree)
      return ["ccs-abc"]
    },
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
    expect(recorded).toEqual({
      woundDown: [WORKTREE],
      killed: ["@7"],
      forgotten: ["ccs-abc"],
      awaited: [4242],
      retired: [WORKTREE],
    })
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
    expect(recorded).toEqual({ woundDown: [], killed: [], forgotten: [], awaited: [], retired: [] })
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
    expect(recorded).toEqual({ woundDown: [], killed: [], forgotten: [], awaited: [], retired: [] })
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
    expect(recorded).toEqual({ woundDown: [], killed: [], forgotten: [], awaited: [], retired: [] })
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
    expect(recorded).toEqual({ woundDown: [], killed: [], forgotten: [], awaited: [], retired: [] })
  })

  test("still reaps a live Claude the record's own pane accounts for", async () => {
    // The ordinary case: the owning runtime is still up when the reaper runs.
    // Its pid IS the pane's pid, so the process-table veto must not fire.
    const { deps, recorded } = makeDeps({ claudeProcessesIn: () => [4242] })

    const [outcome] = await reapArchivedWorktrees(deps)

    expect(outcome.status).toBe("reaped")
    expect(recorded).toEqual({
      woundDown: [WORKTREE],
      killed: ["@7"],
      forgotten: ["ccs-abc"],
      awaited: [4242],
      retired: [WORKTREE],
    })
  })

  test("refuses when a second, paneless Claude shares the record's worktree", async () => {
    // Killing the record's window does not stop the other one.
    const { deps, recorded } = makeDeps({ claudeProcessesIn: () => [4242, 5150] })

    const [outcome] = await reapArchivedWorktrees(deps)

    expect(outcome.status).toBe("skipped occupied")
    expect(outcome.detail).toContain("5150")
    expect(recorded).toEqual({ woundDown: [], killed: [], forgotten: [], awaited: [], retired: [] })
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
    expect(recorded).toEqual({ woundDown: [], killed: [], forgotten: [], awaited: [], retired: [] })
  })

  test("the window is closed before the wind-down removes the directory under it", async () => {
    // The removal is synchronous now, and the pane's shell sits in the
    // worktree — killing after would be removing it out from under a live shell.
    const order: string[] = []
    const { deps } = makeDeps({
      killWindow: () => void order.push("kill"),
      awaitExit: async () => void order.push("awaitExit"),
      windDown: () => {
        order.push("windDown")
        return { pushed: true, removed: true }
      },
    })

    await reapArchivedWorktrees(deps)

    // `tmux kill-window` returns on signal delivery, not on exit. Removing the
    // directory in that gap deletes the cwd of a Claude still flushing.
    expect(order).toEqual(["kill", "awaitExit", "windDown"])
  })

  test("a freshly woken daemon gives runtimes their own detection window first", async () => {
    // archivedAt keeps accruing while the machine sleeps, but the runtime that
    // owns the worktree was asleep too and only starts its detection+grace on
    // wake. Reaping in that instant races a live runtime that never got a
    // chance.
    const { deps, recorded } = makeDeps({ observingSinceMs: NOW - OBSERVER_WARMUP_MS + 60_000 })

    const [outcome] = await reapArchivedWorktrees(deps)

    expect(outcome.status).toBe("skipped observer too young")
    expect(recorded).toEqual({ woundDown: [], killed: [], forgotten: [], awaited: [], retired: [] })
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
    expect(recorded).toEqual({ woundDown: [], killed: [], forgotten: ["ccs-abc"], awaited: [], retired: [WORKTREE] })
  })

  test("a link with no live pane is still reaped — that is the offline case", async () => {
    // Archived while the machine slept and the runtime never came back: no
    // window to kill, but the worktree is exactly what needs cleaning up.
    const { deps, recorded } = makeDeps({ panes: () => [] })

    const [outcome] = await reapArchivedWorktrees(deps)

    expect(outcome.status).toBe("reaped")
    expect(recorded).toEqual({
      woundDown: [WORKTREE],
      killed: [],
      forgotten: ["ccs-abc"],
      awaited: [],
      retired: [WORKTREE],
    })
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
    expect(recorded).toEqual({ woundDown: [], killed: [], forgotten: [], awaited: [], retired: [] })
  })

  test("one failing link does not abort the sweep", async () => {
    const { deps, recorded } = makeDeps({
      links: () => [
        link({ runtimeSessionId: "boom", rootStreamId: "stream_boom", worktree: "/repo/threa.boom" }),
        link({ runtimeSessionId: "ok" }),
      ],
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
    expect(recorded).toEqual({ woundDown: [], killed: [], forgotten: [], awaited: [], retired: [] })
  })

  test("the observer warmup holds back unmarked records only", async () => {
    // Warmup protects a runtime whose detection clock restarted on wake. A
    // runtime that already decided is not that runtime.
    const { deps, recorded } = makeDeps({
      observingSinceMs: NOW - OBSERVER_WARMUP_MS + 60_000,
      links: () => [
        link({ runtimeSessionId: "unmarked", worktree: "/repo/threa.unmarked" }),
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

test("a wind-down that could not remove the directory keeps the identity record", async () => {
  const { deps, recorded } = makeDeps({
    windDown: () => ({ pushed: true, removed: false, reason: "detached HEAD" }),
  })

  const outcomes = await reapArchivedWorktrees(deps, false)

  expect(outcomes[0]?.status).toBe("reaped, worktree left")
  // The directory is still there and the identity is still its own. Retiring it
  // would let the next mint hand that live directory a second id.
  expect(recorded.retired).toEqual([])
  expect(recorded.forgotten).toEqual(["ccs-abc"])
})

test("the window decision uses the injected ledger and canonicalizer", async () => {
  // `decideWindow` used to call the resolver with two arguments, so the
  // ledger-attested branch was unreachable and a second canonicalizer
  // (realpathSync) decided the one destructive call in the daemon.
  const canonicalized: string[] = []
  const { deps, recorded } = makeDeps({
    // No THREA_ env: only the ledger can tie this pane to the record.
    panes: () => [
      pane({
        cwd: `/raw${WORKTREE}`,
        startCommand: "claude --dangerously-load-development-channels server:threa-channel",
      }),
    ],
    // The pane's cwd and the record's worktree differ as RAW strings, so ONLY a
    // canonicalizer applied inside the resolver can tie them together. Passing
    // the raw path on both sides made the assertion pass either way, because
    // canonicalOrRaw falls back to the raw string when realpathSync throws.
    links: () => [link({ worktree: WORKTREE })],
    canonicalPath: (path) => {
      canonicalized.push(path)
      return path.startsWith("/raw") ? path.slice("/raw".length) : path
    },
  })

  const [outcome] = await reapArchivedWorktrees(deps)

  expect(outcome).toMatchObject({ status: "reaped" })
  expect(recorded.killed).toEqual(["@7"])
  expect(canonicalized).toContain(`/raw${WORKTREE}`)
})

test("a worktree two link records disagree about is never reaped", async () => {
  // recordHarnessLink supersedes by a RAW string compare while every reader
  // canonicalizes, so a trailing slash leaves both records alive. The mint
  // refuses on this state; so must the one pass that removes a directory.
  const { deps, recorded } = makeDeps({
    links: () => [link({ runtimeSessionId: "ccs-abc" }), link({ runtimeSessionId: "ccs-xyz" })],
    panes: () => [],
  })

  const outcomes = await reapArchivedWorktrees(deps)

  expect(outcomes.map((outcome) => outcome.status)).toEqual(["skipped ambiguous", "skipped ambiguous"])
  expect(outcomes[0]?.detail).toContain("disagrees")
  expect(recorded).toEqual({ woundDown: [], killed: [], forgotten: [], awaited: [], retired: [] })
})

test("a minted record naming the worktree a different session claims blocks the reap", async () => {
  // The promotion that made this necessary: the minted rung outranks an
  // ambiguous ledger, so a pane declaring nothing resolved to THIS record and
  // the branch below killed a live, differently-identified session's window.
  const { deps, recorded } = makeDeps({
    identities: () => [
      {
        runtimeSessionId: "ccs-stranger",
        instanceId: "cc-stranger",
        worktree: WORKTREE,
        runtimeKind: "claude-code-channel",
        mintedAt: "2026-07-29T00:00:00.000Z",
        source: "mint",
      },
    ],
  })

  const [outcome] = await reapArchivedWorktrees(deps)

  expect(outcome?.status).toBe("skipped ambiguous")
  expect(outcome?.detail).toContain("ccs-stranger")
  expect(recorded.killed).toEqual([])
  expect(recorded.woundDown).toEqual([])
})

test("only the injected identity store reaches the destructive decision", async () => {
  // A record on disk that the deps do not expose must not influence which pane
  // the reaper believes owns the worktree. Reading the ambient store here is how
  // a green test comes to depend on whatever sits in ~/.threa/harnessd.
  const dir = process.env.THREA_HARNESSD_IDENTITIES_DIR!
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, "ccs-ondisk.json"),
    JSON.stringify({
      runtimeSessionId: "ccs-ondisk",
      instanceId: "cc-ondisk",
      worktree: WORKTREE,
      runtimeKind: "claude-code-channel",
      mintedAt: "2026-07-29T00:00:00.000Z",
      source: "mint",
    })
  )
  try {
    const { deps, recorded } = makeDeps({
      identities: () => [],
      panes: () => [pane({ startCommand: "claude --dangerously-load-development-channels server:threa-channel" })],
    })

    const [outcome] = await reapArchivedWorktrees(deps)

    expect(outcome?.status).toBe("reaped")
    expect(recorded.killed).toEqual(["@7"])
  } finally {
    rmSync(join(dir, "ccs-ondisk.json"), { force: true })
  }
})
