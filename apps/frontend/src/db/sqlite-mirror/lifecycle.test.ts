import { afterEach, describe, expect, it } from "vitest"
import { ThreaDatabase } from "../database"
import { SqliteMirror } from "./client"
import {
  persistSqliteStorageMode,
  readSqliteStorageMode,
  startSqliteMirror,
  stopAndDestroySqliteMirror,
} from "./lifecycle"
import type { MirrorRequest } from "./protocol"
import { createBus } from "./test-harness"

afterEach(() => localStorage.removeItem("threa:sqliteStorage"))

describe("sqlite mirror lifecycle", () => {
  it("persists the mode and removes it when off", () => {
    persistSqliteStorageMode("read-only")
    expect(readSqliteStorageMode()).toBe("read-only")
    persistSqliteStorageMode("off")
    expect({ mode: readSqliteStorageMode(), stored: localStorage.getItem("threa:sqliteStorage") }).toEqual({
      mode: "off",
      stored: null,
    })
  })

  it("destroys the mirror's file when stopped for off", async () => {
    const database = new ThreaDatabase(`lifecycle_${Date.now()}`)
    const requests: MirrorRequest["type"][] = []
    startSqliteMirror(
      database,
      "shadow",
      () =>
        new SqliteMirror({
          database,
          mode: "shadow",
          coordination: {
            tabId: "tab",
            liveTabs: async () => new Set(["tab"]),
            watchTab: () => () => {},
            claim: (cb) => cb(true),
            resign: () => {},
            close: () => {},
            broadcast: () => {},
            onBroadcast: () => () => {},
          },
          guard: createBus().guard(database.name),
          createTransport: () => ({
            request: async (request) => {
              requests.push(request.type)
              const status = { backfilled: [], writers: {}, incarnation: null }
              return request.type === "status" ? { ok: true, ms: 0, status } : { ok: true, ms: 0 }
            },
            heardAt: () => 0,
            close: () => {},
          }),
        })
    )
    await new Promise((resolve) => setTimeout(resolve, 100))
    await stopAndDestroySqliteMirror(database)
    expect({ opened: requests[0], last: requests.at(-1), mirror: database.sqliteMirror }).toEqual({
      opened: "open",
      last: "destroy",
      mirror: null,
    })
    database.close()
  })

  it("marks a failure and does not start when Web Locks are missing", () => {
    const database = new ThreaDatabase(`lifecycle_nolocks_${Date.now()}`)
    startSqliteMirror(database, "shadow")
    expect(database.sqliteMirror).toBeNull()
    database.close()
  })
})
