import { afterEach, describe, expect, it } from "vitest"
import { ThreaDatabase } from "../database"
import { adoptDeliveredMode, readSqliteStorageMode, startSqliteMirror } from "./lifecycle"

afterEach(() => {
  for (const key of Object.keys(localStorage)) if (key.startsWith("threa:sqlite")) localStorage.removeItem(key)
})

describe("sqlite mirror lifecycle", () => {
  it("moves a database's requested mode only on a change in one workspace's own delivered value", () => {
    const name = "lifecycle_delivered"
    const adopted = [
      adoptDeliveredMode(name, "ws_on", "read-write"),
      adoptDeliveredMode(name, "ws_off", "off"),
      adoptDeliveredMode(name, "ws_on", "read-write"),
      adoptDeliveredMode(name, "ws_off", "off"),
    ]
    const whileTheyDiffer = { requested: readSqliteStorageMode(name), other: readSqliteStorageMode("other_database") }
    const turnedOff = adoptDeliveredMode(name, "ws_on", "off")
    expect({ adopted, whileTheyDiffer, turnedOff, requested: readSqliteStorageMode(name) }).toEqual({
      adopted: [true, false, false, false],
      whileTheyDiffer: { requested: "read-write", other: "off" },
      turnedOff: true,
      requested: "off",
    })
  })

  it("marks a failure and does not start when Web Locks are missing", () => {
    const database = new ThreaDatabase(`lifecycle_nolocks_${Date.now()}`)
    startSqliteMirror(database, "shadow")
    expect(database.sqliteMirror).toBeNull()
    database.close()
  })
})
