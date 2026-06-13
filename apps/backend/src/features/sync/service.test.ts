import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Pool } from "pg"
import { SyncService } from "./service"
import { SyncLogRepository } from "./repository"
import * as dbModule from "../../db"

function setupService() {
  // withClient just runs the callback with a throwaway client (no DB).
  spyOn(dbModule, "withClient").mockImplementation(async (_pool: any, fn: any) => fn({} as any))
  return new SyncService({ pool: {} as Pool })
}

const baseParams = { workspaceId: "ws_1", userId: "usr_alice", permissionGroups: [], limit: 50 }

describe("SyncService.catchUp retention floor", () => {
  afterEach(() => {
    mock.restore()
  })

  it("returns entries normally when the cursor is at or above the retained floor", async () => {
    const listEntries = spyOn(SyncLogRepository, "listEntriesForUser").mockResolvedValue([
      { syncId: 6n, eventType: "message:created", payload: { workspaceId: "ws_1" }, createdAt: new Date() },
    ])
    spyOn(SyncLogRepository, "getHeadAndRetainedFrom").mockResolvedValue({ head: 9n, retainedFrom: 5n })

    // after == retainedFrom is in-window: the floor is the highest PRUNED id,
    // so everything strictly above it still exists.
    const result = await setupService().catchUp({ ...baseParams, after: 5n })

    expect(result.requiresBootstrap).toBeUndefined()
    expect(result.head).toBe(9n)
    expect(result.entries).toHaveLength(1)
    expect(listEntries).toHaveBeenCalledTimes(1)
  })

  it("signals requiresBootstrap and discards the page when the cursor is below the floor", async () => {
    // Entries are read first (race-safety), then the floor read reveals the
    // cursor is below it — the surviving page is dropped in favor of bootstrap.
    spyOn(SyncLogRepository, "listEntriesForUser").mockResolvedValue([
      { syncId: 150n, eventType: "message:created", payload: { workspaceId: "ws_1" }, createdAt: new Date() },
    ])
    spyOn(SyncLogRepository, "getHeadAndRetainedFrom").mockResolvedValue({ head: 200n, retainedFrom: 100n })

    const result = await setupService().catchUp({ ...baseParams, after: 50n })

    expect(result).toEqual({ entries: [], head: 200n, requiresBootstrap: true })
  })

  it("does not signal requiresBootstrap when nothing has been pruned (floor 0)", async () => {
    spyOn(SyncLogRepository, "listEntriesForUser").mockResolvedValue([])
    spyOn(SyncLogRepository, "getHeadAndRetainedFrom").mockResolvedValue({ head: 0n, retainedFrom: 0n })

    const result = await setupService().catchUp({ ...baseParams, after: 0n })

    expect(result.requiresBootstrap).toBeUndefined()
  })
})
