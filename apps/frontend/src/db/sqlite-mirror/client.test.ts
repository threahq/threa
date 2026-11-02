import sqlite3InitModule, { type Database } from "@sqlite.org/sqlite-wasm"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { ThreaDatabase } from "../database"
import { SqliteMirror, type MirrorCoordination } from "./client"
import { createMirrorHandler } from "./handler"
import { decodeValue } from "./value-codec"
import type { MirrorTransport } from "./protocol"
import { SQLITE_UNMIRRORED_STORES } from "./stores"

let sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>>
beforeAll(async () => {
  sqlite3 = await sqlite3InitModule()
})

const owned: Array<() => void> = []
afterEach(() => {
  for (const cleanup of owned.splice(0)) cleanup()
})

let counter = 0

function ownerCoordination(): MirrorCoordination {
  return {
    claim: (onChange) => onChange(true),
    release: () => {},
    broadcast: () => {},
    onBroadcast: () => () => {},
  }
}

function setup() {
  counter += 1
  const database = new ThreaDatabase(`sqlite_mirror_${counter}_${Date.now()}`)
  const sqlite: Database = new sqlite3.oo1.DB(":memory:")
  const handler = createMirrorHandler(async () => ({
    db: sqlite,
    close: () => {},
    destroy: () => {},
  }))
  const transport: MirrorTransport = { request: (request) => handler.handle(request), close: () => {} }
  const mirror = new SqliteMirror({ database, coordination: ownerCoordination(), createTransport: () => transport })
  database.sqliteMirror = mirror
  owned.push(() => {
    database.close()
    sqlite.close()
  })
  return { database, sqlite, mirror }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 5))
}

function mirrored(sqlite: Database, store: string): unknown[] {
  return sqlite.selectValues(`SELECT v FROM "s_${store}" ORDER BY k`).map((v) => decodeValue(String(v)))
}

describe("SqliteMirror", () => {
  it("mirrors committed writes and backfills pre-existing rows", async () => {
    const { database, sqlite, mirror } = setup()
    await database.open()
    await database.syncCursors.bulkPut([
      { key: "old_a", value: "1", updatedAt: 1 },
      { key: "old_b", value: "2", updatedAt: 2 },
    ] as never)
    await database.pendingMessages.put({ clientId: "c1", streamId: "s1", createdAt: 1 } as never)
    mirror.start()
    await settle()

    await database.syncCursors.put({ key: "new", value: "3", updatedAt: 3 } as never)
    await database.syncCursors.delete("old_a")
    await database.syncCursors.where("key").equals("old_b").modify({ updatedAt: 99 })
    await database.pendingMessages.put({ clientId: "c2", streamId: "s1", createdAt: 2 } as never)
    await database.transaction("rw", database.syncCursors, database.pendingMessages, async () => {
      await database.syncCursors.put({ key: "tx", value: "4", updatedAt: 4 } as never)
      await database.pendingMessages.clear()
    })
    await settle()

    const stores = database.tables.map((t) => t.name).filter((name) => !SQLITE_UNMIRRORED_STORES.has(name))
    const actual: Record<string, unknown[]> = {}
    const expected: Record<string, unknown[]> = {}
    for (const store of stores) {
      actual[store] = mirrored(sqlite, store)
      expected[store] = await database.table(store).toCollection().toArray()
    }
    expect(actual).toEqual(expected)
    expect(expected.syncCursors).toHaveLength(3)
    expect(
      sqlite.selectValues(`SELECT name FROM sqlite_master WHERE name IN ('s_e2eDeviceKeys','s_uploadJobs')`)
    ).toEqual([])
  })

  it("mirrors nothing from an aborted transaction", async () => {
    const { database, sqlite, mirror } = setup()
    await database.open()
    mirror.start()
    await settle()

    await expect(
      database.transaction("rw", database.syncCursors, async () => {
        await database.syncCursors.put({ key: "doomed", value: "x", updatedAt: 1 } as never)
        throw new Error("abort")
      })
    ).rejects.toThrow("abort")
    await database.syncCursors.put({ key: "kept", value: "y", updatedAt: 2 } as never)
    await settle()

    expect(mirrored(sqlite, "syncCursors")).toEqual([{ key: "kept", value: "y", updatedAt: 2 }])
  })

  it("drops only an unmirrorable entry", async () => {
    const { database, sqlite, mirror } = setup()
    await database.open()
    mirror.start()
    await settle()

    await database.syncCursors.bulkPut([
      { key: "bad", value: new Blob(["x"]), updatedAt: 1 },
      { key: "good", value: "ok", updatedAt: 2 },
    ] as never)
    await settle()

    expect(mirrored(sqlite, "syncCursors")).toEqual([{ key: "good", value: "ok", updatedAt: 2 }])
  })
})
