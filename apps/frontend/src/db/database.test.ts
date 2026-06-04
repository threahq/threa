import { beforeEach, describe, expect, it } from "vitest"
import { clearAllCachedData, db } from "./database"
import { hasSeededWorkspaceCache, seedWorkspaceCache } from "@/stores/workspace-store"

describe("clearAllCachedData", () => {
  beforeEach(async () => {
    await clearAllCachedData()
  })

  it("clears the in-memory workspace cache alongside IndexedDB", async () => {
    seedWorkspaceCache("workspace_1", {
      workspace: {
        id: "workspace_1",
        name: "Workspace",
        slug: "workspace",
        createdAt: "2026-03-01T10:00:00Z",
        updatedAt: "2026-03-01T10:00:00Z",
        _cachedAt: Date.now(),
      },
      users: [
        {
          id: "user_1",
          workspaceId: "workspace_1",
          workosUserId: "workos_1",
          email: "kris@example.com",
          role: "owner",
          slug: "kris",
          name: "Kris",
          description: null,
          avatarUrl: null,
          timezone: "Europe/Stockholm",
          locale: "en",
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
          joinedAt: "2026-03-01T10:00:00Z",
          _cachedAt: Date.now(),
        },
      ],
      streams: [],
      memberships: [],
      dmPeers: [],
      personas: [],
      bots: [],
      unreadState: {
        id: "workspace_1",
        workspaceId: "workspace_1",
        unreadCounts: {},
        mentionCounts: {},
        activityCounts: {},
        unreadActivityCount: 0,
        mutedStreamIds: [],
        _cachedAt: Date.now(),
      },
      userPreferences: {
        id: "workspace_1",
        workspaceId: "workspace_1",
        userId: "user_1",
        theme: "system",
        sendMode: "enter",
        _cachedAt: Date.now(),
      },
      metadata: {
        id: "workspace_1",
        workspaceId: "workspace_1",
        emojis: [],
        emojiWeights: {},
        commands: [],
        _cachedAt: Date.now(),
      },
    })
    await db.workspaces.put({
      id: "workspace_1",
      name: "Workspace",
      slug: "workspace",
      createdAt: "2026-03-01T10:00:00Z",
      updatedAt: "2026-03-01T10:00:00Z",
      _cachedAt: Date.now(),
    })

    expect(hasSeededWorkspaceCache("workspace_1")).toBe(true)

    await clearAllCachedData()

    expect(await db.workspaces.count()).toBe(0)
    expect(hasSeededWorkspaceCache("workspace_1")).toBe(false)
  })
})
