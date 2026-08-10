import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BackfillOutcome } from "./backfill"
import type { TombstoneOutcome } from "./tombstone"
import {
  STARTUP_LOCK_WAIT_MS,
  clearAgent,
  defaultStartupReconciliationDeps,
  startupReconciliation,
  type ClearDeps,
} from "./commands"
import type { LocalTmuxPane } from "./discovery"
import { resumeActiveLockPath } from "./lock"
import type { ManagedAgent, ResumeOptions } from "./types"

let root: string
const previousIdentities = process.env.THREA_HARNESSD_IDENTITIES_DIR
const previousLinks = process.env.THREA_HARNESS_LINKS_DIR
const previousInventory = process.env.THREA_HARNESSD_INVENTORY

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "harnessd-startup-"))
  process.env.THREA_HARNESSD_IDENTITIES_DIR = join(root, "identities")
  process.env.THREA_HARNESS_LINKS_DIR = join(root, "links")
  process.env.THREA_HARNESSD_INVENTORY = join(root, "inventory.sqlite")
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  restore("THREA_HARNESSD_IDENTITIES_DIR", previousIdentities)
  restore("THREA_HARNESS_LINKS_DIR", previousLinks)
  restore("THREA_HARNESSD_INVENTORY", previousInventory)
})

const recorded: BackfillOutcome[] = [{ subject: "/repo/a", disposition: "recorded" }]
const tombstoned: TombstoneOutcome[] = [{ subject: "claude-1", disposition: "tombstoned" }]

test("startupReconciliation backfills, then sweeps, then tombstones", async () => {
  // The tombstone pass is the only half that talks to the network, and nothing
  // the sweep does depends on it — ahead of the sweep it delayed every boot
  // revival by one request per worktree-gone row. The lock is held across each
  // half and released before the sweep either way.
  const calls: string[] = []

  await startupReconciliation({
    backfill: () => {
      calls.push("backfill")
      return recorded
    },
    tombstone: async () => {
      calls.push("tombstone")
      return tombstoned
    },
    lock: async () => {
      calls.push("lock")
      return () => calls.push("release")
    },
    sweep: () => {
      calls.push("sweep")
    },
    log: (message) => calls.push(`log:${message}`),
  })

  expect(calls).toEqual([
    "lock",
    "backfill",
    "log:harnessd: identity backfill: 1 subject(s), 1 recorded",
    "release",
    "sweep",
    "lock",
    "tombstone",
    "log:harnessd: tombstone: 1 row(s), 1 tombstoned",
    "release",
  ])
})

test("a failing tombstone logs and does not abort the startup pass", async () => {
  // It is the half that does network I/O, so it is by far the likelier to throw
  // — and `threaTarget` throws outright when no credentials are readable.
  const calls: string[] = []

  await startupReconciliation({
    backfill: () => [],
    tombstone: async () => {
      throw new Error("threa unreachable")
    },
    lock: async () => () => calls.push("release"),
    sweep: () => void calls.push("sweep"),
    log: (message) => calls.push(`log:${message}`),
  })

  expect(calls).toEqual([
    "log:harnessd: identity backfill: 0 subject(s)",
    "release",
    "sweep",
    "release",
    "log:harnessd: tombstone pass failed: threa unreachable",
  ])
})

test("a failing backfill logs and does not abort the startup pass", async () => {
  const calls: string[] = []

  await startupReconciliation({
    backfill: () => {
      throw new Error("inventory unreadable")
    },
    tombstone: async () => [],
    lock: async () => () => {},
    sweep: () => {
      calls.push("sweep")
    },
    log: (message) => calls.push(`log:${message}`),
  })

  expect(calls).toEqual([
    "log:harnessd: identity backfill failed: inventory unreadable",
    "sweep",
    "log:harnessd: tombstone: 0 row(s)",
  ])
})

test("a lock the startup pass cannot take is logged, and the sweep still runs", async () => {
  // acquireProcessLock spins to a 10-minute deadline and throws when the holder
  // is alive. Letting that escape exited the process, launchd restarted it, and
  // it took the lock again — a crash loop with no transports and no reap.
  const swept: string[] = []
  const logged: string[] = []

  await startupReconciliation({
    backfill: () => [],
    tombstone: async () => [],
    lock: async () => {
      throw new Error("lock /tmp/resume-active.lock held by pid 4242 for over 600s")
    },
    sweep: () => void swept.push("sweep"),
    log: (message) => void logged.push(message),
  })

  expect(swept).toEqual(["sweep"])
  expect(logged.join("\n")).toContain("held by pid 4242")
})

test("a dry-run startup pass does not take the lock the live daemon holds", async () => {
  // `resumeActive` and `reapArchived` both skip the lock for a dry run. A
  // preview that takes it blocks the live daemon's revive and reap for its
  // duration — and if the daemon holds it, the preview hangs ten minutes and
  // then exits instead of printing a preview.
  const path = resumeActiveLockPath()
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, String(process.pid))

  const release = await defaultStartupReconciliationDeps(() => {}, true).lock()
  release()

  expect(existsSync(path)).toBe(true)
  expect(readFileSync(path, "utf8")).toBe(String(process.pid))
})

test("a held lock delays startup by a bounded wait, not the default ten minutes", async () => {
  // Until this resolves no transport is built and no reap runs, so an unbounded
  // wait turns one wedged holder into a silent outage for as long as it lives.
  expect(STARTUP_LOCK_WAIT_MS).toBeLessThanOrEqual(60_000)

  const path = resumeActiveLockPath()
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, String(process.pid))
  const swept: string[] = []
  const logged: string[] = []

  const startedAt = Date.now()
  await startupReconciliation({
    ...defaultStartupReconciliationDeps(() => void swept.push("sweep"), false, 60),
    backfill: () => [],
    tombstone: async () => [],
    log: (message) => void logged.push(message),
  })

  expect(Date.now() - startedAt).toBeLessThan(2_000)
  expect(swept).toEqual(["sweep"])
  expect(logged.join("\n")).toContain("backfill failed")
})

const online: ManagedAgent = {
  id: "claude-1",
  name: "fix-sidebar",
  runtime: "claude",
  status: "online",
  worktree: "/repo/fix-sidebar",
  runtimeSessionId: "ccs-sidebar",
  command: [],
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z",
}

const livePane: LocalTmuxPane = {
  sessionName: "threa-agents",
  windowName: "fix-sidebar",
  windowId: "@7",
  paneId: "%9",
  panePid: 4242,
  cwd: "/repo/fix-sidebar",
  startCommand: "claude --name threa.fix-sidebar",
}

function clearHarness(agent: ManagedAgent, overrides: Partial<ClearDeps> = {}) {
  const calls: string[] = []
  const killed: string[] = []
  const persisted: ManagedAgent[] = []
  const revived: Array<{ agent: ManagedAgent; options: ResumeOptions }> = []
  const deps: ClearDeps = {
    findAgent: () => agent,
    resolvePane: () => ({ status: "missing" }),
    killWindow: (windowId) => {
      calls.push("kill")
      killed.push(windowId)
    },
    claudePidsIn: () => [],
    sleep: async () => void calls.push("sleep"),
    lock: async () => {
      calls.push("lock")
      return () => void calls.push("release")
    },
    persist: (persistedAgent) => {
      calls.push("persist")
      persisted.push(persistedAgent)
    },
    revive: async (revivedAgent, options) => {
      calls.push("revive")
      revived.push({ agent: revivedAgent, options })
      return { status: "started" }
    },
    ...overrides,
  }
  return { calls, killed, persisted, revived, deps }
}

/** Resolves as `first` once, then `rest` — a kill that worked makes the pane disappear. */
function paneSequence(first: ReturnType<ClearDeps["resolvePane"]>, rest: ReturnType<ClearDeps["resolvePane"]>) {
  let seen = 0
  return () => (seen++ === 0 ? first : rest)
}

describe("clearAgent", () => {
  test("kills the verified pane and relaunches fresh, holding the lock across both", async () => {
    // The lock is the whole reason this is safe to run while the watcher sweeps:
    // released between kill and relaunch, the watcher revives the OLD
    // conversation into the worktree the clear just emptied.
    const { calls, killed, persisted, revived, deps } = clearHarness(online, {
      resolvePane: paneSequence({ status: "found", pane: livePane }, { status: "missing" }),
    })

    await clearAgent("fix-sidebar", deps)

    // The marker lands BEFORE the kill: a relaunch that fails after it leaves the
    // next sweep completing the clear instead of resuming the old conversation.
    expect(calls).toEqual(["lock", "persist", "kill", "revive", "release"])
    expect(killed).toEqual(["@7"])
    const stamped = persisted[0]
    const stamp = stamped?.clearPendingAt ?? ""
    expect(stamped).toEqual({ ...online, clearPendingAt: stamp, updatedAt: stamp })
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(revived).toEqual([{ agent: stamped!, options: { fresh: true } }])
  })

  test("refuses an unverified pane without killing or relaunching", async () => {
    const { calls, persisted, deps } = clearHarness(online, {
      resolvePane: () => ({ status: "unverified", pane: livePane, reason: "only a recycled tmux id (%9)" }),
    })

    await expect(clearAgent("fix-sidebar", deps)).rejects.toThrow("only a recycled tmux id")
    // A refused clear changes no state: a pending marker here would make the next
    // sweep wipe a conversation nobody asked to drop.
    expect({ calls, persisted }).toEqual({ calls: ["lock", "release"], persisted: [] })
  })

  test("refuses an ambiguous pane without killing or relaunching", async () => {
    const { calls, persisted, deps } = clearHarness(online, {
      resolvePane: () => ({ status: "ambiguous", reason: "two panes claim ccs-sidebar" }),
    })

    await expect(clearAgent("fix-sidebar", deps)).rejects.toThrow("two panes claim ccs-sidebar")
    expect({ calls, persisted }).toEqual({ calls: ["lock", "release"], persisted: [] })
  })

  test("clearing an agent with no live pane skips the kill and revives fresh", async () => {
    const { calls, killed, persisted, revived, deps } = clearHarness(online)

    await clearAgent("fix-sidebar", deps)

    // Marked even with nothing to kill: this revive can fail too.
    expect(calls).toEqual(["lock", "persist", "revive", "release"])
    expect(killed).toEqual([])
    expect(revived).toEqual([{ agent: persisted[0]!, options: { fresh: true } }])
    expect(persisted[0]?.clearPendingAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  test("a runtime that will not drain relaunches nothing", async () => {
    // Relaunching over a process that is still holding the worktree is the
    // duplicate-session failure the drain exists to prevent.
    const { calls, deps } = clearHarness(online, {
      resolvePane: () => ({ status: "found", pane: livePane }),
    })

    await expect(clearAgent("fix-sidebar", deps)).rejects.toThrow("did not exit within 15s")
    expect(calls.filter((call) => call === "sleep")).toHaveLength(60)
    expect(calls).not.toContain("revive")
    expect(calls.at(-1)).toBe("release")
  })

  test("clearing a stopped agent revives it, because clear is an explicit restart", async () => {
    // reviveAgent returns "skipped stopped" for a stopped row, so passing it
    // through unchanged would make clear a no-op on exactly the rows that need it.
    const stopped = { ...online, status: "stopped" as const }
    const { revived, deps } = clearHarness(stopped)

    await clearAgent("fix-sidebar", deps)

    const stamp = revived[0]?.agent.clearPendingAt ?? ""
    expect(revived).toEqual([
      { agent: { ...stopped, status: "starting", clearPendingAt: stamp, updatedAt: stamp }, options: { fresh: true } },
    ])
  })

  test("a revive outcome other than started is printed and fails the command", async () => {
    const logged: string[] = []
    const log = spyOn(console, "log").mockImplementation((message: string) => void logged.push(message))
    const { deps } = clearHarness(online, {
      revive: async () => ({ status: "skipped archived", detail: "scratchpad is archived" }),
    })

    try {
      await expect(clearAgent("fix-sidebar", deps)).rejects.toThrow(
        "clear did not start fix-sidebar: skipped archived; the fresh start is still pending and the next revival ('threa-harnessd up' or the watcher) completes it"
      )
    } finally {
      log.mockRestore()
    }

    expect(logged).toEqual(["skipped archived\tfix-sidebar\tscratchpad is archived"])
  })
})
