import { describe, it, expect, beforeEach } from "vitest"
import { db, type CachedWorkspace, type CachedWorkspaceUser } from "@/db"
import { isSharedStreamRegistrationEnabledSync, resetEventWriteFlags } from "@/db/event-writes"
import {
  getCachedWorkspaceTables,
  resetWorkspaceStoreCache,
  seedCacheFromIdb,
  seedWorkspaceCache,
  subscribeWorkspaceCache,
} from "./workspace-store"

const WS = "ws_pub"

function makeWorkspace(): CachedWorkspace {
  return {
    id: WS,
    name: "Publication",
    slug: "publication",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    _cachedAt: Date.now(),
  }
}

function makeUser(name: string): CachedWorkspaceUser {
  return {
    id: "user_1",
    workspaceId: WS,
    workosUserId: "workos_1",
    email: "kris@example.com",
    role: "owner",
    slug: "kris",
    name,
    description: null,
    avatarUrl: null,
    timezone: null,
    locale: null,
    pronouns: null,
    phone: null,
    githubUsername: null,
    statusEmoji: null,
    statusText: null,
    statusExpiresAt: null,
    statusPausesNotifications: false,
    notificationsPausedUntil: null,
    notificationsPausedIndefinitely: false,
    setupCompleted: true,
    joinedAt: "2026-01-01T00:00:00Z",
    _cachedAt: Date.now(),
  }
}

function seed(users: CachedWorkspaceUser[], options?: { publish?: boolean }): void {
  seedWorkspaceCache(
    WS,
    {
      workspace: makeWorkspace(),
      users,
      streams: [],
      memberships: [],
      dmPeers: [],
      personas: [],
      bots: [],
    },
    options
  )
}

describe("seedWorkspaceCache publication gating", () => {
  beforeEach(async () => {
    resetWorkspaceStoreCache()
    await Promise.all([db.workspaces.clear(), db.workspaceUsers.clear(), db.workspaceMetadata.clear()])
  })

  it("seedWorkspaceCache with publish:false does not notify subscribers", () => {
    let notifications = 0
    const unsubscribe = subscribeWorkspaceCache(WS, () => {
      notifications += 1
    })

    seed([makeUser("Kris")], { publish: false })

    expect(notifications).toBe(0)
    // ...and the data landed regardless: the gate is about waking readers.
    expect(getCachedWorkspaceTables(WS).users).toHaveLength(1)
    unsubscribe()
  })

  it("seedWorkspaceCache with publish:false still advances the write-ordering version", async () => {
    // IDB holds the stale row; the cache is about to receive the fresh one from
    // a non-publishing seed while seedCacheFromIdb is mid-flight.
    await db.workspaces.put(makeWorkspace())
    await db.workspaceUsers.put(makeUser("Stale"))

    const idbSeed = seedCacheFromIdb(WS)
    seed([makeUser("Fresh")], { publish: false })
    await idbSeed

    expect(getCachedWorkspaceTables(WS).users?.map((u) => u.name)).toEqual(["Fresh"])
  })

  it("a warm start primes the stream-registration flag before any bootstrap", async () => {
    resetEventWriteFlags()
    await db.workspaces.put(makeWorkspace())
    await db.workspaceMetadata.put({
      id: WS,
      workspaceId: WS,
      emojis: [],
      emojiWeights: {},
      commands: [],
      featureFlags: { workspace: { sharedStreamRegistration: "on" }, user: {} },
      _cachedAt: Date.now(),
    } as unknown as Parameters<typeof db.workspaceMetadata.put>[0])

    expect(await seedCacheFromIdb(WS)).toBe(true)

    expect(isSharedStreamRegistrationEnabledSync(WS)).toBe(true)
  })

  it("a publishing seed notifies exactly once", () => {
    let notifications = 0
    const unsubscribe = subscribeWorkspaceCache(WS, () => {
      notifications += 1
    })

    seed([makeUser("Kris")])

    expect(notifications).toBe(1)
    unsubscribe()
  })
})
