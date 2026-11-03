import Dexie from "dexie"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ThreaDatabase } from "./database"
import { sqliteMarksStore } from "./sqlite-mirror/marks"
import { isMirroredStore } from "./sqlite-mirror/stores"
import { setIdbRelaxedDurability } from "./transaction-middleware"
import { NO_CAPTURE, PerfCapture, armPerfCapture } from "@/lib/perf/capture"

let counter = 0
function freshDb(): ThreaDatabase {
  counter += 1
  return new ThreaDatabase(`txn_middleware_${counter}_${Date.now()}`)
}

afterEach(() => {
  setIdbRelaxedDurability(true)
  armPerfCapture(NO_CAPTURE)
  vi.restoreAllMocks()
})

describe("transaction durability", () => {
  // Below the app middleware, so it sees exactly what reaches IndexedDB.
  async function openRecording(): Promise<{
    db: ThreaDatabase
    writes: Array<{ stores: string[]; durability: string }>
  }> {
    const db = freshDb()
    const writes: Array<{ stores: string[]; durability: string }> = []
    db.use({
      stack: "dbcore",
      level: 0,
      create: (down) => ({
        ...down,
        transaction: (stores, mode, options) => {
          if (mode === "readwrite") writes.push({ stores, durability: options?.durability ?? "default" })
          return down.transaction(stores, mode, options)
        },
      }),
    })
    await db.open()
    writes.length = 0
    return { db, writes }
  }

  it("relaxes cache-only writes and keeps device-only writes strict", async () => {
    const { db, writes } = await openRecording()

    await db.syncCursors.put({ key: "cursor_1", value: "1", updatedAt: 1 } as never)
    await db.pendingMessages.put({ clientId: "client_1", streamId: "stream_1", createdAt: 1 } as never)

    expect(writes).toEqual([
      { stores: ["syncCursors", "sqliteMarks:syncCursors"], durability: "relaxed" },
      { stores: ["pendingMessages", "sqliteMarks:pendingMessages"], durability: "default" },
    ])
    db.close()
  })

  it("keeps a write strict when any of its stores is device-only", async () => {
    const { db, writes } = await openRecording()

    await db.transaction("rw", db.syncCursors, db.docStates, async () => {
      await db.syncCursors.put({ key: "cursor_1", value: "1", updatedAt: 1 } as never)
    })

    expect(writes).toEqual([
      {
        stores: ["syncCursors", "docStates", "sqliteMarks:syncCursors", "sqliteMarks:docStates"],
        durability: "default",
      },
    ])
    db.close()
  })

  it("leaves every write on the browser default when the flag is off", async () => {
    setIdbRelaxedDurability(false)
    const { db, writes } = await openRecording()

    await db.syncCursors.put({ key: "cursor_1", value: "1", updatedAt: 1 } as never)

    expect(writes).toEqual([{ stores: ["syncCursors", "sqliteMarks:syncCursors"], durability: "default" }])
    db.close()
  })
})

describe("SQLite mirror marks", () => {
  it("gives every mirrored store its own marks store", async () => {
    const db = freshDb()
    await db.open()
    const names = db.tables.map((table) => table.name)

    expect(names.filter(isMirroredStore).filter((store) => !names.includes(sqliteMarksStore(store)))).toEqual([])
    db.close()
  })

  it("runs readwrite transactions on disjoint mirrored stores concurrently", async () => {
    const db = freshDb()
    await db.open()
    let releasedYet = false
    let markRunning!: () => void
    const running = new Promise<void>((resolve) => (markRunning = resolve))
    const finished: string[] = []

    // Holds its scope with a chain of requests until released.
    const held = db.transaction("rw", db.streams, async () => {
      await db.streams.put({ id: "held", workspaceId: "ws" } as never)
      markRunning()
      while (!releasedYet) await db.streams.count()
    })
    await running
    // Resolved inside the held transaction, `running` would otherwise carry its zone into these writes.
    const disjoint = Dexie.ignoreTransaction(() =>
      db.syncCursors.put({ key: "cursor_1", value: "1", updatedAt: 1 } as never)
    ).then(() => finished.push("disjoint"))
    const overlapping = Dexie.ignoreTransaction(() => db.streams.put({ id: "after", workspaceId: "ws" } as never)).then(
      () => finished.push("overlapping")
    )
    await Promise.race([disjoint, new Promise((resolve) => setTimeout(resolve, 1000))])
    finished.push("released")
    releasedYet = true
    await Promise.all([held, disjoint, overlapping])

    expect(finished).toEqual(["disjoint", "released", "overlapping"])
    db.close()
  })
})

describe("transaction capture", () => {
  it("records slow transactions with their stores while a capture is armed", async () => {
    const db = freshDb()
    await db.open()
    const capture = new PerfCapture()
    armPerfCapture(capture)
    let clock = 0
    vi.spyOn(performance, "now").mockImplementation(() => (clock += 50))

    await db.syncCursors.put({ key: "cursor_1", value: "1", updatedAt: 1 } as never)
    await db.syncCursors.get("cursor_1")

    const storeOrder = db.tables
      .map((table) => table.name)
      .filter((name) => !name.startsWith("sqliteMarks:"))
      .sort()
    const samples = () => capture.snapshot().map(({ name, value }) => ({ name, value }))
    // A read's `complete` fires after its result resolves, on no fixed tick.
    await vi.waitFor(() => expect(samples()).toHaveLength(6))
    expect(samples()).toEqual([
      { name: "idb.txStores", value: 2 ** storeOrder.indexOf("syncCursors") },
      { name: "idb.writeTx", value: expect.any(Number) },
      { name: "idb.writeTxCommit", value: expect.any(Number) },
      { name: "idb.txStores", value: 2 ** storeOrder.indexOf("syncCursors") },
      { name: "idb.readTx", value: expect.any(Number) },
      { name: "idb.readTxWait", value: expect.any(Number) },
    ])
    db.close()
  })
})
