import { describe, it, expect, beforeEach } from "vitest"
import { db } from "@/db"
import { acknowledgeSnapshotCursorInCurrentTransaction, SyncLogCursor, syncLogCursorKey } from "./sync-log-cursor"

const WORKSPACE_ID = "ws_cursor_test"
const KEY = syncLogCursorKey(WORKSPACE_ID)

async function persistedCursor(): Promise<string | undefined> {
  return (await db.syncCursors.get(KEY))?.cursor
}

describe("SyncLogCursor", () => {
  beforeEach(async () => {
    await db.syncCursors.clear()
  })

  it("advances monotonically by BigInt comparison", () => {
    const cursor = new SyncLogCursor(WORKSPACE_ID)

    expect(cursor.get()).toBeNull()
    cursor.advance("10")
    expect(cursor.get()).toBe("10")
    // Lower and equal ids never move the cursor back
    cursor.advance("9")
    cursor.advance("10")
    expect(cursor.get()).toBe("10")
    // String comparison would put "9" > "10"; BigInt must win
    cursor.advance("100")
    expect(cursor.get()).toBe("100")
    cursor.dispose()
  })

  it("ignores malformed sync ids instead of throwing (hot onAny path)", async () => {
    const cursor = new SyncLogCursor(WORKSPACE_ID)
    cursor.advance("10")

    cursor.advance("")
    cursor.advance("1.5")
    cursor.advance("abc")
    expect(cursor.get()).toBe("10")
    cursor.dispose()

    // A corrupted persisted row must not poison the load either
    await db.syncCursors.put({ key: KEY, cursor: "not-a-number", updatedAt: Date.now() })
    const reloaded = new SyncLogCursor(WORKSPACE_ID)
    await reloaded.load()
    expect(reloaded.get()).toBeNull()
    reloaded.dispose()
  })

  it("loads the persisted cursor and merges with in-memory advances by max", async () => {
    await db.syncCursors.put({ key: KEY, cursor: "50", updatedAt: Date.now() })

    const behind = new SyncLogCursor(WORKSPACE_ID)
    behind.advance("20")
    await behind.load()
    expect(behind.get()).toBe("50")
    behind.dispose()

    const ahead = new SyncLogCursor(WORKSPACE_ID)
    ahead.advance("80")
    await ahead.load()
    expect(ahead.get()).toBe("80")
    ahead.dispose()
  })

  it("acknowledges a snapshot durably without rewinding a newer cursor", async () => {
    await db.syncCursors.put({ key: KEY, cursor: "50", updatedAt: Date.now() })

    await db.transaction("rw", db.syncCursors, async () => {
      expect(await acknowledgeSnapshotCursorInCurrentTransaction(WORKSPACE_ID, "40")).toBe("50")
    })

    expect(await persistedCursor()).toBe("50")
  })

  it("adopts a cursor already committed with snapshot rows without scheduling another write", async () => {
    const cursor = new SyncLogCursor(WORKSPACE_ID)
    await db.syncCursors.put({ key: KEY, cursor: "70", updatedAt: Date.now() })

    cursor.acknowledgeDurable("70")

    expect(cursor.get()).toBe("70")
    cursor.dispose()
  })

  it("persists pending advances on flush", async () => {
    const cursor = new SyncLogCursor(WORKSPACE_ID)
    cursor.advance("7")
    await cursor.flush()

    expect(await persistedCursor()).toBe("7")
    cursor.dispose()
  })

  it("persists on the debounce timer without an explicit flush", async () => {
    const cursor = new SyncLogCursor(WORKSPACE_ID, 5)
    cursor.advance("3")

    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(await persistedCursor()).toBe("3")
    cursor.dispose()
  })

  it("never moves the persisted cursor backwards (multi-tab convergence)", async () => {
    const tabA = new SyncLogCursor(WORKSPACE_ID)
    tabA.advance("100")
    await tabA.flush()

    const tabB = new SyncLogCursor(WORKSPACE_ID)
    tabB.advance("40")
    await tabB.flush()

    expect(await persistedCursor()).toBe("100")
    tabA.dispose()
    tabB.dispose()
  })

  it("dispose cancels pending writes and blocks later ones (account-switch safety)", async () => {
    const cursor = new SyncLogCursor(WORKSPACE_ID, 5)
    cursor.advance("12")
    cursor.dispose()

    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(await persistedCursor()).toBeUndefined()

    cursor.advance("13")
    await cursor.flush()
    expect(await persistedCursor()).toBeUndefined()
  })
})
