/**
 * Workspace A holds 205 users, more than a list capped at 200 returns. Workspace B holds a user with
 * A's slug and name and one only B has, so a read that drops its `workspace_id` pin surfaces them.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { PeoplePurposes, UserRepository, type PeopleScope, type PeopleViewer } from "../../src/features/workspaces"
import { userId, workspaceId } from "../../src/lib/id"
import { setupTestDatabase } from "./setup"

const SEEDED_USERS = 205
const SHARED_INDEX = 7
const JOINED_AT_EPOCH = Date.UTC(2026, 0, 1)

describe("people scope", () => {
  let pool: Pool
  const wsA = workspaceId()
  const wsB = workspaceId()
  const aUsers = Array.from({ length: SEEDED_USERS }, (_, index) => ({
    id: userId(),
    slug: index === SHARED_INDEX ? "zebulon-quarrington" : `seeded-${index}`,
    name: index === SHARED_INDEX ? "Zebulon Quarrington" : `Seeded ${index}`,
    joinedAt: new Date(JOINED_AT_EPOCH + index * 1000),
  }))
  const shared = aUsers[SHARED_INDEX]!
  const bShared = { id: userId(), slug: shared.slug, name: shared.name, joinedAt: new Date(JOINED_AT_EPOCH) }
  const bOnly = { id: userId(), slug: "only-in-b", name: "Only In B", joinedAt: new Date(JOINED_AT_EPOCH + 1000) }
  const aIds = aUsers.map((user) => user.id)
  const idsOf = (users: { id: string }[]) => users.map((user) => user.id)

  async function seedUsers(workspace: string, users: typeof aUsers) {
    await pool.query(
      `INSERT INTO users (id, workspace_id, workos_user_id, email, role, slug, name, joined_at)
       SELECT t.id, $1, NULL, NULL, 'member', t.slug, t.name, t.joined_at
       FROM unnest($2::text[], $3::text[], $4::text[], $5::timestamptz[]) AS t(id, slug, name, joined_at)`,
      [workspace, idsOf(users), users.map((u) => u.slug), users.map((u) => u.name), users.map((u) => u.joinedAt)]
    )
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
    await seedUsers(wsA, aUsers)
    await seedUsers(wsB, [bShared, bOnly])
  })

  afterAll(async () => {
    await pool.end()
  })

  const viewers: PeopleViewer[] = [{ kind: "user", userId: aUsers[0]!.id }, { kind: "workspace" }]
  const scopes: PeopleScope[] = viewers.flatMap((viewer) =>
    Object.values(PeoplePurposes).map((purpose) => ({ viewer, purpose }))
  )

  for (const scope of scopes) {
    test(`should read only workspace A's users from every scoped read when the viewer is ${scope.viewer.kind} and the purpose is ${scope.purpose}`, async () => {
      const cursor = { cursorJoinedAt: aUsers[2]!.joinedAt, cursorId: aUsers[2]!.id }

      expect({
        listed: idsOf(await UserRepository.listByWorkspace(pool, wsA, scope)),
        queried: idsOf(await UserRepository.listByWorkspace(pool, wsA, scope, { query: "Quarrington" })),
        firstPage: idsOf(await UserRepository.listByWorkspace(pool, wsA, scope, { limit: 3 })),
        secondPage: idsOf(await UserRepository.listByWorkspace(pool, wsA, scope, { limit: 3, ...cursor })),
        bySlugs: idsOf(await UserRepository.findBySlugs(pool, wsA, [shared.slug, bOnly.slug], scope)),
        searched: idsOf(await UserRepository.searchByNameOrSlug(pool, wsA, "Zebulon Quarrington", 10, scope)),
        byIds: idsOf(await UserRepository.findByIds(pool, wsA, [shared.id, bShared.id, bOnly.id], scope)),
        byId: (await UserRepository.findById(pool, wsA, shared.id, scope))?.id,
        byIdFromB: (await UserRepository.findById(pool, wsA, bOnly.id, scope))?.id ?? null,
      }).toEqual({
        listed: aIds,
        queried: [shared.id],
        firstPage: aIds.slice(0, 3),
        secondPage: aIds.slice(3, 6),
        bySlugs: [shared.id],
        searched: [shared.id],
        byIds: [shared.id],
        byId: shared.id,
        byIdFromB: null,
      })
    })
  }
})
