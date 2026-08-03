import { db, type CachedWorkspaceUser } from "@/db"

/**
 * Shared workspace-row seeding for component tests. `workspaceUsersTable()`
 * resolves the table at call time — `db` is an account-scoped proxy, so binding
 * it at module load would pin whichever account was active then. A test spies
 * its `where` to count reads ("one per workspace, not one per row").
 */
export function workspaceUsersTable(): typeof db.workspaceUsers {
  return db.workspaceUsers
}

export async function clearWorkspaceActorTables(): Promise<void> {
  await db.workspaceUsers.clear()
  await db.personas.clear()
  await db.bots.clear()
  await db.workspaceMetadata.clear()
}

export async function seedWorkspaceUser(workspaceId: string, id: string, name = "Test User"): Promise<void> {
  const user: CachedWorkspaceUser = {
    id,
    workspaceId,
    workosUserId: `workos_${id}`,
    email: `${id}@example.com`,
    role: "member",
    slug: id,
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
    joinedAt: "2026-03-01T10:00:00Z",
    _cachedAt: 1,
  }
  await db.workspaceUsers.put(user)
}
