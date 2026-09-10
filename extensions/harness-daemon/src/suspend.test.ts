import { describe, expect, test } from "bun:test"
import type { ClaudeNativeSession } from "./claude-registry"
import { IDLE_SUSPEND_AFTER_MS } from "./idle"
import { suspendAgent, wakeAgent, type SuspendDeps } from "./suspend"
import type { ManagedAgent } from "./types"

const NOW = Date.UTC(2026, 8, 9, 12, 0, 0)
const IDLE_SINCE = NOW - IDLE_SUSPEND_AFTER_MS - 60_000
const IDLE_DETAIL = `idle ${IDLE_SUSPEND_AFTER_MS / 60_000 + 1}m`

const agent = (overrides: Partial<ManagedAgent> = {}): ManagedAgent => ({
  id: "agt_1",
  name: "feature",
  runtime: "claude",
  status: "online",
  worktree: "/repo/threa.feature",
  tmuxWindowId: "@7",
  tmuxPaneId: "%9",
  runtimeSessionId: "ccs-abc",
  command: ["claude"],
  createdAt: "2026-09-09T09:00:00.000Z",
  updatedAt: "2026-09-09T09:00:00.000Z",
  ...overrides,
})

const session = (overrides: Partial<ClaudeNativeSession> = {}): ClaudeNativeSession => ({
  pid: 4242,
  sessionId: "11111111-2222-4333-8444-555555555555",
  cwd: "/repo/threa.feature",
  procStart: "900",
  status: "idle",
  statusUpdatedAt: IDLE_SINCE,
  ...overrides,
})

interface Recorder {
  deps: SuspendDeps
  persisted: ManagedAgent[]
  respawned: Array<[string, string, string]>
  killed: string[]
  notes: Array<{ runtimeSessionId: string; suspendedAt: string; wokeAt: string }>
}

function recorder(overrides: Partial<SuspendDeps> = {}): Recorder {
  const persisted: ManagedAgent[] = []
  const respawned: Array<[string, string, string]> = []
  const killed: string[] = []
  const notes: Recorder["notes"] = []
  return {
    persisted,
    respawned,
    killed,
    notes,
    deps: {
      pane: () => ({
        status: "found",
        pane: {
          sessionName: "threa-agents",
          windowName: "feature",
          windowId: "@7",
          paneId: "%9",
          panePid: 4242,
          cwd: "/repo/threa.feature",
          startCommand: "claude",
        },
      }),
      sessions: () => [session()],
      probe: { children: () => [], cmdline: () => "", now: () => NOW },
      respawn: (paneId, cwd, command) => respawned.push([paneId, cwd, command]),
      killWindow: (windowId) => killed.push(windowId),
      persist: (row) => persisted.push(row),
      writeWakeNote: (note) => notes.push(note),
      now: () => NOW,
      ...overrides,
    },
  }
}

describe("suspendAgent", () => {
  test("marks the row before it kills anything, then respawns the pane on a placeholder", () => {
    const it = recorder()

    const outcome = suspendAgent(agent(), it.deps, { thresholdMs: IDLE_SUSPEND_AFTER_MS })

    expect({
      outcome,
      persisted: it.persisted.map((row) => [row.status, row.suspendedAt]),
      respawned: it.respawned.map(([paneId, cwd]) => [paneId, cwd]),
      placeholderMentionsTheName: it.respawned[0]?.[2].includes("feature"),
    }).toEqual({
      outcome: { status: "suspended", detail: IDLE_DETAIL },
      persisted: [["suspended", "2026-09-09T12:00:00.000Z"]],
      respawned: [["%9", "/repo/threa.feature"]],
      placeholderMentionsTheName: true,
    })
  })

  test("rolls the row back online when the session takes work up between the two checks", () => {
    let reads = 0
    const it = recorder({
      sessions: () => [session(reads++ === 0 ? {} : { status: "busy" })],
    })

    const outcome = suspendAgent(agent(), it.deps, { thresholdMs: IDLE_SUSPEND_AFTER_MS })

    expect({
      outcome,
      persisted: it.persisted.map((row) => [row.status, row.suspendedAt]),
      respawned: it.respawned,
    }).toEqual({
      outcome: { status: "skipped", detail: "took work up while winding down: runtime is busy" },
      persisted: [
        ["suspended", "2026-09-09T12:00:00.000Z"],
        ["online", undefined],
      ],
      respawned: [],
    })
  })

  test("refuses a Pi row, an already-suspended row, a held row, a paneless row, and an ambiguous worktree", () => {
    const held = new Date(NOW + 60_000).toISOString()
    const missingPane = recorder({ pane: () => ({ status: "missing" }) })
    const twoSessions = recorder({ sessions: () => [session(), session({ pid: 4343 })] })
    const options = { thresholdMs: IDLE_SUSPEND_AFTER_MS }

    expect({
      pi: suspendAgent(agent({ runtime: "pi" }), recorder().deps, options),
      already: suspendAgent(agent({ status: "suspended" }), recorder().deps, options),
      held: suspendAgent(agent({ suspendHoldUntil: held }), recorder().deps, options),
      paneless: suspendAgent(agent(), missingPane.deps, options),
      ambiguous: suspendAgent(agent(), twoSessions.deps, options),
      writes: [...missingPane.persisted, ...twoSessions.persisted, ...missingPane.respawned],
    }).toEqual({
      pi: { status: "skipped", detail: "pi sessions are not suspendable" },
      already: { status: "skipped", detail: "already suspended" },
      held: { status: "skipped", detail: `held until ${held}` },
      paneless: { status: "skipped", detail: "no pane of its own" },
      ambiguous: { status: "skipped", detail: "2 live Claude sessions in the worktree" },
      writes: [],
    })
  })

  test("reports what a dry run would do without touching the row", () => {
    const it = recorder()

    expect({
      outcome: suspendAgent(agent(), it.deps, { thresholdMs: IDLE_SUSPEND_AFTER_MS, dryRun: true }),
      writes: [...it.persisted, ...it.respawned],
    }).toEqual({ outcome: { status: "would suspend", detail: IDLE_DETAIL }, writes: [] })
  })
})

describe("wakeAgent", () => {
  test("leaves a wake note, clears the suspension and kills the placeholder window", () => {
    const it = recorder()
    const suspended = agent({ status: "suspended", suspendedAt: "2026-09-09T11:44:00.000Z" })

    const woken = wakeAgent(suspended, it.deps)

    expect({
      woken: [woken.status, woken.suspendedAt, woken.updatedAt],
      persisted: it.persisted.map((row) => row.status),
      killed: it.killed,
      notes: it.notes,
    }).toEqual({
      woken: ["online", undefined, "2026-09-09T12:00:00.000Z"],
      persisted: ["online"],
      killed: ["@7"],
      notes: [
        {
          runtimeSessionId: "ccs-abc",
          suspendedAt: "2026-09-09T11:44:00.000Z",
          wokeAt: "2026-09-09T12:00:00.000Z",
        },
      ],
    })
  })
})
