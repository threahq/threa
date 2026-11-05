import sqlite3InitModule from "@sqlite.org/sqlite-wasm"
import { beforeAll } from "vitest"
import { setActiveDb } from "../database"
import { mirroredDatabases } from "./mirrored-databases"

// Points the app's `db` at a database SQLite serves read-write, so suites written against IndexedDB prove parity.
// Never closed: like the IndexedDB setup.ts abandons per file, it takes the late writes of this file's work
// instead of failing them on a closed database.
beforeAll(async () => {
  const { openMirrored } = mirroredDatabases(await sqlite3InitModule(), [])
  const { database, mirror } = openMirrored()
  await database.open()
  if (!mirror.readWrite) throw new Error("The read-write suite's database is not served by SQLite")
  setActiveDb(database)
})
