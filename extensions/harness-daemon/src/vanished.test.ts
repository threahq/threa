import { describe, expect, test } from "bun:test"
import type { LocalTmuxPane, ManagedAgentPane } from "./discovery"
import type { ManagedAgent } from "./types"
import { createVanishedPaneSweep } from "./vanished"

function agent(overrides: Partial<ManagedAgent> = {}): ManagedAgent {
  return {
    id: "agent-1",
    name: "feature",
    runtime: "claude",
    status: "online",
    worktree: "/tmp/worktrees/feature",
    tmuxPaneId: "%8",
    scratchpadUrl: "https://app.threa.io/w/ws_1/s/stream_01ABCDEF",
    instanceId: "cc-one",
    runtimeSessionId: "ccs-one",
    command: ["threa-harnessd", "spawn", "claude", "--name", "feature"],
    createdAt: "2026-09-02T06:00:00.000Z",
    updatedAt: "2026-09-02T06:00:00.000Z",
    ...overrides,
  }
}

function pane(overrides: Partial<LocalTmuxPane> = {}): LocalTmuxPane {
  return {
    sessionName: "0",
    windowName: "feature",
    windowId: "@7",
    paneId: "%8",
    panePid: 4242,
    cwd: "/tmp/worktrees/feature",
    startCommand: "claude",
    ...overrides,
  }
}

const found = (p: LocalTmuxPane = pane()): ManagedAgentPane => ({ status: "found", pane: p })
const missing: ManagedAgentPane = { status: "missing" }

function sweep(rows: ManagedAgent[], panes: Map<string, ManagedAgentPane>) {
  return createVanishedPaneSweep({ inventory: () => rows, panes: () => panes })
}

describe("createVanishedPaneSweep", () => {
  test("should report a row with its last pane when the pane was present and is now missing", () => {
    const panes = new Map<string, ManagedAgentPane>([["agent-1", found()]])
    const row = agent()
    const watcher = sweep([row], panes)
    expect(watcher.next()).toEqual({ vanished: [], live: [{ agent: row, pane: pane() }] })
    expect(watcher.next().vanished).toEqual([])
    panes.set("agent-1", missing)
    expect(watcher.next()).toEqual({ vanished: [{ agent: row, lastPane: pane() }], live: [] })
  })

  test("should not report a row that was already missing when the watcher started", () => {
    const watcher = sweep([agent()], new Map([["agent-1", missing]]))
    expect(watcher.next().vanished).toEqual([])
    expect(watcher.next().vanished).toEqual([])
  })

  test("should report a row once per disappearance, not every pass it stays missing", () => {
    const panes = new Map<string, ManagedAgentPane>([["agent-1", found()]])
    const row = agent()
    const watcher = sweep([row], panes)
    watcher.next()
    panes.set("agent-1", missing)
    expect(watcher.next().vanished.map((v) => v.agent)).toEqual([row])
    expect(watcher.next().vanished).toEqual([])
    const revived = pane({ paneId: "%12", panePid: 5151 })
    panes.set("agent-1", found(revived))
    expect(watcher.next()).toEqual({ vanished: [], live: [{ agent: row, pane: revived }] })
    panes.set("agent-1", missing)
    expect(watcher.next().vanished).toEqual([{ agent: row, lastPane: revived }])
  })

  test("should count ambiguous and unverified panes as present but not attributable", () => {
    const panes = new Map<string, ManagedAgentPane>([
      ["agent-1", { status: "ambiguous", reason: "two panes" }],
      ["agent-2", { status: "unverified", pane: pane({ paneId: "%3" }), reason: "recycled id" }],
    ])
    const rows = [agent(), agent({ id: "agent-2", name: "other", worktree: "/tmp/worktrees/other" })]
    const watcher = sweep(rows, panes)
    expect(watcher.next().live).toEqual([])
    panes.set("agent-1", missing)
    panes.set("agent-2", missing)
    expect(watcher.next().vanished).toEqual([{ agent: rows[0] }, { agent: rows[1] }])
  })

  test("should ignore rows that are stopped, tombstoned, or unlinked", () => {
    const panes = new Map<string, ManagedAgentPane>([
      ["stopped", found()],
      ["tombstoned", found()],
      ["unlinked", found()],
      ["live", found()],
    ])
    const rows = [
      agent({ id: "stopped", name: "stopped", status: "stopped", worktree: "/tmp/worktrees/stopped" }),
      agent({
        id: "tombstoned",
        name: "tombstoned",
        tombstonedAt: "2026-09-01T00:00:00.000Z",
        worktree: "/tmp/worktrees/tombstoned",
      }),
      agent({ id: "unlinked", name: "unlinked", scratchpadUrl: undefined, worktree: "/tmp/worktrees/unlinked" }),
      agent({ id: "live", name: "live", worktree: "/tmp/worktrees/live" }),
    ]
    const watcher = sweep(rows, panes)
    expect(watcher.next().live.map((entry) => entry.agent.id)).toEqual(["live"])
    for (const id of panes.keys()) panes.set(id, missing)
    expect(watcher.next().vanished.map((entry) => entry.agent.id)).toEqual(["live"])
  })

  test("should only consider the newest row of a session", () => {
    const panes = new Map<string, ManagedAgentPane>([
      ["old", found()],
      ["new", found()],
    ])
    const older = agent({ id: "old", updatedAt: "2026-09-01T00:00:00.000Z" })
    const newer = agent({ id: "new", tmuxPaneId: "%9", updatedAt: "2026-09-02T00:00:00.000Z" })
    const watcher = sweep([older, newer], panes)
    watcher.next()
    panes.set("old", missing)
    panes.set("new", missing)
    expect(watcher.next().vanished.map((v) => v.agent)).toEqual([newer])
  })
})
