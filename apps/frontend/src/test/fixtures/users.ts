import type { User } from "@threa/types"

/**
 * Factory for creating mock User objects.
 */
export function createMockUser(overrides: Partial<User> & { id: string; workosUserId: string }): User {
  return {
    workspaceId: "workspace_1",
    email: `${overrides.workosUserId}@test.com`,
    role: "member",
    slug: overrides.workosUserId.replace("workos_", ""),
    name: "Test User",
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
    joinedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  }
}

/**
 * Pre-built mock workspace users.
 */
export const mockUsers = {
  martin: createMockUser({
    id: "member_1",
    workosUserId: "workos_user_1",
    role: "admin",
    slug: "martin",
    name: "Martin",
    email: "martin@test.com",
  }),
  kate: createMockUser({
    id: "member_2",
    workosUserId: "workos_user_2",
    role: "member",
    slug: "kate",
    name: "Kate",
    email: "kate@test.com",
  }),
  alice: createMockUser({
    id: "member_3",
    workosUserId: "workos_user_3",
    role: "member",
    slug: "alice",
    name: "Alice",
    email: "alice@test.com",
  }),
}

/**
 * Array of all mock users.
 */
export const mockUsersList: User[] = Object.values(mockUsers)
