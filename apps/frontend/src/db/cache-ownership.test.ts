import { afterEach, describe, expect, it, vi } from "vitest"
import Dexie from "dexie"
import { CACHE_OWNER_ID, ThreaDatabase, accountDbName } from "./database"

const ACCOUNT_A = "user_a"
const ACCOUNT_B = "user_b"

const opened: ThreaDatabase[] = []

function open(name: string, owner?: string): ThreaDatabase {
  const database = new ThreaDatabase(name, owner)
  opened.push(database)
  return database
}

function workspaceRow(id: string) {
  return {
    id,
    name: "Workspace",
    slug: "workspace",
    createdAt: "2026-03-01T10:00:00Z",
    updatedAt: "2026-03-01T10:00:00Z",
    _cachedAt: Date.now(),
  }
}

afterEach(async () => {
  for (const database of opened.splice(0)) {
    database.close()
    await Dexie.delete(database.name)
  }
  vi.restoreAllMocks()
})

describe("account database naming", () => {
  it("should name a database the account owns it, under a scheme the unmarked databases never used", () => {
    expect(accountDbName(ACCOUNT_A)).toBe("threa_v2_user_a")
    expect(accountDbName(ACCOUNT_A)).not.toBe(`threa_${ACCOUNT_A}`)
  })
})

describe("cache ownership", () => {
  it("should claim an account's own database on first open", async () => {
    const database = open(accountDbName(ACCOUNT_A), ACCOUNT_A)
    await database.workspaces.put(workspaceRow("workspace_1"))

    expect(await database.cacheOwnership.get(CACHE_OWNER_ID)).toEqual({
      id: CACHE_OWNER_ID,
      workosUserId: ACCOUNT_A,
    })
    expect(await database.workspaces.get("workspace_1")).toMatchObject({ id: "workspace_1" })
  })

  it("should reopen a database it already owns without touching what is in it", async () => {
    const first = open(accountDbName(ACCOUNT_A), ACCOUNT_A)
    await first.workspaces.put(workspaceRow("workspace_1"))
    first.close()

    const second = open(accountDbName(ACCOUNT_A), ACCOUNT_A)
    expect(await second.workspaces.get("workspace_1")).toMatchObject({ id: "workspace_1" })
    expect(await second.cacheOwnership.get(CACHE_OWNER_ID)).toEqual({
      id: CACHE_OWNER_ID,
      workosUserId: ACCOUNT_A,
    })
  })

  it("should rebuild cold rather than hand one account the data another account's marker claims", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    const shared = "threa_v2_collided"

    const first = open(shared, ACCOUNT_A)
    await first.workspaces.put(workspaceRow("workspace_1"))
    await first.pendingMessages.put({
      clientId: "client_1",
      workspaceId: "workspace_1",
      streamId: "stream_1",
      contentJson: { type: "doc", content: [] },
      createdAt: new Date().toISOString(),
      retryCount: 0,
    } as never)
    first.close()

    const second = open(shared, ACCOUNT_B)
    expect(await second.workspaces.toArray()).toEqual([])
    expect(await second.pendingMessages.toArray()).toEqual([])
    expect(await second.cacheOwnership.get(CACHE_OWNER_ID)).toEqual({
      id: CACHE_OWNER_ID,
      workosUserId: ACCOUNT_B,
    })
    expect(consoleError).toHaveBeenCalled()
  })

  it("should leave the pre-auth handle unmarked, since no account owns it", async () => {
    const database = open("threa_pre_auth_probe")
    await database.open()

    expect(await database.cacheOwnership.get(CACHE_OWNER_ID)).toBeUndefined()
  })
})
