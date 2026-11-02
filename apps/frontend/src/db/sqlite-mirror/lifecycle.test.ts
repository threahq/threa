import { afterEach, describe, expect, it } from "vitest"
import { ThreaDatabase } from "../database"
import { persistSqliteStorageMode, readSqliteStorageMode, startSqliteMirror } from "./lifecycle"

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

  it("marks a failure and does not start when Web Locks are missing", () => {
    const database = new ThreaDatabase(`lifecycle_nolocks_${Date.now()}`)
    startSqliteMirror(database, "shadow")
    expect(database.sqliteMirror).toBeNull()
    database.close()
  })
})
