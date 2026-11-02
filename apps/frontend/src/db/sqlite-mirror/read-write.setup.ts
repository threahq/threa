import sqlite3InitModule from "@sqlite.org/sqlite-wasm"
import { beforeAll } from "vitest"
import { setActiveDb } from "../database"
import { mirroredDatabases } from "./mirrored-databases"

// Points the app's `db` at a database SQLite serves read-write, so suites written against IndexedDB prove parity.
// Never closed: like the IndexedDB setup.ts abandons per file, it takes the late writes of this file's work
// instead of failing them on a closed database.
beforeAll(async () => {
  const { copiedSession, openMirrored } = mirroredDatabases(await sqlite3InitModule(), [])
  const { name, sqlite } = await copiedSession({ mode: "read-write" })
  const { database, mirror } = openMirrored({ name, sqlite, mode: "read-write" })
  await database.open()
  if (!mirror.readWrite) throw new Error("The read-write suite's database did not enter read-write")
  setActiveDb(database)
})
