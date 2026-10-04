/**
 * Workspace A holds 205 users, more than a list capped at 200 returns. Workspace B holds a user with
 * A's slug and name and one only B has, joined inside the cursor page, so a read that drops its
 * `workspace_id` pin surfaces them.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import type { Pool } from "pg"
import { sql } from "../../src/db"
import { PeoplePurposes, UserRepository, type PeopleScope, type PeopleViewer } from "../../src/features/workspaces"
import * as peopleModule from "../../src/features/workspaces/people"
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
  const bOnly = { id: userId(), slug: "only-in-b", name: "Only In B", joinedAt: new Date(JOINED_AT_EPOCH + 3500) }
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

  const cursor = { cursorJoinedAt: aUsers[2]!.joinedAt, cursorId: aUsers[2]!.id }

  for (const scope of scopes) {
    test(`should read only workspace A's users from every scoped read when the viewer is ${scope.viewer.kind} and the purpose is ${scope.purpose}`, async () => {
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

  test("should hide the users the people predicate excludes from every scoped read when the predicate carries values", async () => {
    const hiddenById = aUsers[1]!
    const spy = spyOn(peopleModule, "peopleScopeSql").mockImplementation(
      () => sql`(u.slug <> ${shared.slug} AND u.id <> ${hiddenById.id})`
    )
    try {
      const scope = scopes[0]!
      const visibleIds = idsOf(aUsers.filter((user) => user !== shared && user !== hiddenById))

      expect({
        listed: idsOf(await UserRepository.listByWorkspace(pool, wsA, scope)),
        queried: idsOf(await UserRepository.listByWorkspace(pool, wsA, scope, { query: "Seeded 1", limit: 3 })),
        firstPage: idsOf(await UserRepository.listByWorkspace(pool, wsA, scope, { limit: 3 })),
        secondPage: idsOf(await UserRepository.listByWorkspace(pool, wsA, scope, { limit: 3, ...cursor })),
        bySlugs: idsOf(await UserRepository.findBySlugs(pool, wsA, [shared.slug, aUsers[3]!.slug], scope)),
        searched: idsOf(await UserRepository.searchByNameOrSlug(pool, wsA, "Zebulon Quarrington", 10, scope)),
        byIds: idsOf(await UserRepository.findByIds(pool, wsA, [shared.id, aUsers[3]!.id], scope)),
        byId: (await UserRepository.findById(pool, wsA, shared.id, scope))?.id ?? null,
        byIdUnscoped: (await UserRepository.findById(pool, wsA, shared.id))?.id,
      }).toEqual({
        listed: visibleIds,
        queried: [aUsers[10]!.id, aUsers[11]!.id, aUsers[12]!.id],
        firstPage: [aUsers[0]!.id, aUsers[2]!.id, aUsers[3]!.id],
        secondPage: [aUsers[3]!.id, aUsers[4]!.id, aUsers[5]!.id],
        bySlugs: [aUsers[3]!.id],
        searched: [],
        byIds: [aUsers[3]!.id],
        byId: null,
        byIdUnscoped: shared.id,
      })
    } finally {
      spy.mockRestore()
    }
  })
})
