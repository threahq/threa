import { describe, expect, test } from "bun:test"
import type { ManagedAgentPane } from "./discovery"
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

function sweep(rows: ManagedAgent[], statuses: Map<string, ManagedAgentPane["status"]>) {
  return createVanishedPaneSweep({ inventory: () => rows, paneStatuses: () => statuses })
}

describe("createVanishedPaneSweep", () => {
  test("should report a row when its pane was present and is now missing", () => {
    const statuses = new Map<string, ManagedAgentPane["status"]>([["agent-1", "found"]])
    const rows = [agent()]
    const watcher = sweep(rows, statuses)
    expect(watcher.next()).toEqual([])
    expect(watcher.next()).toEqual([])
    statuses.set("agent-1", "missing")
    expect(watcher.next()).toEqual(rows)
  })

  test("should not report a row that was already missing when the watcher started", () => {
    const watcher = sweep([agent()], new Map([["agent-1", "missing"]]))
    expect(watcher.next()).toEqual([])
    expect(watcher.next()).toEqual([])
  })

  test("should report a row once per disappearance, not every pass it stays missing", () => {
    const statuses = new Map<string, ManagedAgentPane["status"]>([["agent-1", "found"]])
    const row = agent()
    const watcher = sweep([row], statuses)
    watcher.next()
    statuses.set("agent-1", "missing")
    expect(watcher.next()).toEqual([row])
    expect(watcher.next()).toEqual([])
    statuses.set("agent-1", "found")
    expect(watcher.next()).toEqual([])
    statuses.set("agent-1", "missing")
    expect(watcher.next()).toEqual([row])
  })

  test("should count ambiguous and unverified panes as present", () => {
    const statuses = new Map<string, ManagedAgentPane["status"]>([
      ["agent-1", "ambiguous"],
      ["agent-2", "unverified"],
    ])
    const rows = [agent(), agent({ id: "agent-2", name: "other", worktree: "/tmp/worktrees/other" })]
    const watcher = sweep(rows, statuses)
    watcher.next()
    statuses.set("agent-1", "missing")
    statuses.set("agent-2", "missing")
    expect(watcher.next()).toEqual(rows)
  })

  test("should ignore rows that are stopped, tombstoned, or unlinked", () => {
    const statuses = new Map<string, ManagedAgentPane["status"]>([
      ["stopped", "found"],
      ["tombstoned", "found"],
      ["unlinked", "found"],
      ["live", "found"],
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
    const watcher = sweep(rows, statuses)
    watcher.next()
    for (const id of statuses.keys()) statuses.set(id, "missing")
    expect(watcher.next().map((row) => row.id)).toEqual(["live"])
  })

  test("should only consider the newest row of a session", () => {
    const statuses = new Map<string, ManagedAgentPane["status"]>([
      ["old", "found"],
      ["new", "found"],
    ])
    const older = agent({ id: "old", updatedAt: "2026-09-01T00:00:00.000Z" })
    const newer = agent({ id: "new", tmuxPaneId: "%9", updatedAt: "2026-09-02T00:00:00.000Z" })
    const watcher = sweep([older, newer], statuses)
    watcher.next()
    statuses.set("old", "missing")
    statuses.set("new", "missing")
    expect(watcher.next()).toEqual([newer])
  })
})
