import { afterEach, describe, expect, it } from "vitest"
import { ThreaDatabase } from "../database"
import { SqliteMirror } from "./client"
import {
  persistSqliteStorageMode,
  readSqliteStorageMode,
  startSqliteShadow,
  stopAndDestroySqliteShadow,
} from "./lifecycle"
import type { MirrorRequest } from "./protocol"

afterEach(() => localStorage.removeItem("threa:sqliteStorage"))

describe("sqlite shadow lifecycle", () => {
  it("persists the mode and removes it when off", () => {
    persistSqliteStorageMode("shadow")
    expect(readSqliteStorageMode()).toBe("shadow")
    persistSqliteStorageMode("off")
    expect({ mode: readSqliteStorageMode(), stored: localStorage.getItem("threa:sqliteStorage") }).toEqual({
      mode: "off",
      stored: null,
    })
  })

  it("destroys the mirror's file when stopped for off", async () => {
    const database = new ThreaDatabase(`lifecycle_${Date.now()}`)
    const requests: MirrorRequest["type"][] = []
    startSqliteShadow(
      database,
      () =>
        new SqliteMirror({
          database,
          coordination: {
            claim: (cb) => cb(true),
            resign: () => {},
            close: () => {},
            broadcast: () => {},
            onBroadcast: () => () => {},
          },
          createTransport: () => ({
            request: async (request) => {
              requests.push(request.type)
              return { ok: true, ms: 0, backfilled: [] }
            },
            close: () => {},
          }),
        })
    )
    await new Promise((resolve) => setTimeout(resolve, 100))
    await stopAndDestroySqliteShadow(database)
    expect({ opened: requests[0], last: requests.at(-1), mirror: database.sqliteMirror }).toEqual({
      opened: "open",
      last: "destroy",
      mirror: null,
    })
    database.close()
  })

  it("marks a failure and does not start when Web Locks are missing", () => {
    const database = new ThreaDatabase(`lifecycle_nolocks_${Date.now()}`)
    startSqliteShadow(database)
    expect(database.sqliteMirror).toBeNull()
    database.close()
  })
})
