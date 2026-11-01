import { afterEach, describe, expect, it, vi } from "vitest"
import { ThreaDatabase } from "./database"
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
      { stores: ["syncCursors"], durability: "relaxed" },
      { stores: ["pendingMessages"], durability: "default" },
    ])
    db.close()
  })

  it("leaves every write on the browser default when the flag is off", async () => {
    setIdbRelaxedDurability(false)
    const { db, writes } = await openRecording()

    await db.syncCursors.put({ key: "cursor_1", value: "1", updatedAt: 1 } as never)

    expect(writes).toEqual([{ stores: ["syncCursors"], durability: "default" }])
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
    await new Promise((resolve) => setTimeout(resolve, 0))

    const storeOrder = db.tables.map((table) => table.name).sort()
    const samples = capture.snapshot().map(({ name, value }) => ({ name, value }))
    expect(samples).toEqual([
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
