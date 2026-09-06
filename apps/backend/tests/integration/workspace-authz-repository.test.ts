import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import type { Pool } from "pg"
import { WORKSPACE_ROLE_SLUGS } from "@threahq/types"
import { WorkspaceUserPermissionsRepository } from "../../src/features/workspace-authz"
import { setupTestDatabase } from "./setup"

const WORKSPACE_ID = "ws_authz_repo_test"
const OTHER_WORKSPACE_ID = "ws_authz_repo_other"
const USER_ID = "workos_user_authz_repo_test"
const OTHER_USER_ID = "workos_user_authz_repo_other"

describe("WorkspaceUserPermissionsRepository", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query(
      `DELETE FROM workspace_user_permissions
       WHERE workspace_id = ANY($1::text[])`,
      [[WORKSPACE_ID, OTHER_WORKSPACE_ID]]
    )
  })

  describe("upsert", () => {
    test("inserts a new row and returns the mapped value", async () => {
      const t0 = new Date("2026-01-01T00:00:00Z")
      const result = await WorkspaceUserPermissionsRepository.upsert(pool, {
        workspaceId: WORKSPACE_ID,
        workosUserId: USER_ID,
        roleSlugs: [WORKSPACE_ROLE_SLUGS.ADMIN],
        status: "active",
        lastEventAt: t0,
      })
      expect(result).not.toBeNull()
      expect(result?.workspaceId).toBe(WORKSPACE_ID)
      expect(result?.roleSlugs).toEqual([WORKSPACE_ROLE_SLUGS.ADMIN])
      expect(result?.lastEventAt).toEqual(t0)
    })

    test("overwrites when a strictly newer event arrives", async () => {
      const t0 = new Date("2026-01-01T00:00:00Z")
      const t1 = new Date("2026-01-01T00:00:30Z")
      await WorkspaceUserPermissionsRepository.upsert(pool, {
        workspaceId: WORKSPACE_ID,
        workosUserId: USER_ID,
        roleSlugs: [WORKSPACE_ROLE_SLUGS.MEMBER],
        status: "active",
        lastEventAt: t0,
      })
      const next = await WorkspaceUserPermissionsRepository.upsert(pool, {
        workspaceId: WORKSPACE_ID,
        workosUserId: USER_ID,
        roleSlugs: [WORKSPACE_ROLE_SLUGS.ADMIN],
        status: "active",
        lastEventAt: t1,
      })
      expect(next?.roleSlugs).toEqual([WORKSPACE_ROLE_SLUGS.ADMIN])
    })

    test("rejects a stale upsert via the timestamp guard (INV-20)", async () => {
      const t0 = new Date("2026-01-01T00:00:00Z")
      const tStale = new Date("2025-12-31T23:00:00Z")
      await WorkspaceUserPermissionsRepository.upsert(pool, {
        workspaceId: WORKSPACE_ID,
        workosUserId: USER_ID,
        roleSlugs: [WORKSPACE_ROLE_SLUGS.ADMIN],
        status: "active",
        lastEventAt: t0,
      })
      const stale = await WorkspaceUserPermissionsRepository.upsert(pool, {
        workspaceId: WORKSPACE_ID,
        workosUserId: USER_ID,
        roleSlugs: [WORKSPACE_ROLE_SLUGS.MEMBER],
        status: "active",
        lastEventAt: tStale,
      })
      expect(stale).toBeNull()
      const persisted = await WorkspaceUserPermissionsRepository.getByWorkspaceAndUser(pool, WORKSPACE_ID, USER_ID)
      expect(persisted?.roleSlugs).toEqual([WORKSPACE_ROLE_SLUGS.ADMIN])
    })

    test("equal timestamp does not overwrite (strict <, INV-20)", async () => {
      const t0 = new Date("2026-01-01T00:00:00Z")
      await WorkspaceUserPermissionsRepository.upsert(pool, {
        workspaceId: WORKSPACE_ID,
        workosUserId: USER_ID,
        roleSlugs: [WORKSPACE_ROLE_SLUGS.ADMIN],
        status: "active",
        lastEventAt: t0,
      })
      const replay = await WorkspaceUserPermissionsRepository.upsert(pool, {
        workspaceId: WORKSPACE_ID,
        workosUserId: USER_ID,
        roleSlugs: [WORKSPACE_ROLE_SLUGS.MEMBER],
        status: "active",
        lastEventAt: t0,
      })
      expect(replay).toBeNull()
    })
  })

  describe("delete", () => {
    test("removes a row when the deletion event is newer", async () => {
      const t0 = new Date("2026-01-01T00:00:00Z")
      const t1 = new Date("2026-01-01T00:00:30Z")
      await WorkspaceUserPermissionsRepository.upsert(pool, {
        workspaceId: WORKSPACE_ID,
        workosUserId: USER_ID,
        roleSlugs: [WORKSPACE_ROLE_SLUGS.ADMIN],
        status: "active",
        lastEventAt: t0,
      })
      const removed = await WorkspaceUserPermissionsRepository.delete(pool, {
        workspaceId: WORKSPACE_ID,
        workosUserId: USER_ID,
        eventCreatedAt: t1,
      })
      expect(removed).toBe(true)
      expect(await WorkspaceUserPermissionsRepository.getByWorkspaceAndUser(pool, WORKSPACE_ID, USER_ID)).toBeNull()
    })

    test("preserves the row when a stale deletion arrives", async () => {
      const t0 = new Date("2026-01-01T00:00:00Z")
      const tStale = new Date("2025-12-31T23:00:00Z")
      await WorkspaceUserPermissionsRepository.upsert(pool, {
        workspaceId: WORKSPACE_ID,
        workosUserId: USER_ID,
        roleSlugs: [WORKSPACE_ROLE_SLUGS.ADMIN],
        status: "active",
        lastEventAt: t0,
      })
      const removed = await WorkspaceUserPermissionsRepository.delete(pool, {
        workspaceId: WORKSPACE_ID,
        workosUserId: USER_ID,
        eventCreatedAt: tStale,
      })
      expect(removed).toBe(false)
      expect(await WorkspaceUserPermissionsRepository.getByWorkspaceAndUser(pool, WORKSPACE_ID, USER_ID)).not.toBeNull()
    })
  })

  describe("listByWorkspace", () => {
    test("returns only rows for the given workspace", async () => {
      const t0 = new Date("2026-01-01T00:00:00Z")
      await WorkspaceUserPermissionsRepository.upsert(pool, {
        workspaceId: WORKSPACE_ID,
        workosUserId: USER_ID,
        roleSlugs: [WORKSPACE_ROLE_SLUGS.ADMIN],
        status: "active",
        lastEventAt: t0,
      })
      await WorkspaceUserPermissionsRepository.upsert(pool, {
        workspaceId: WORKSPACE_ID,
        workosUserId: OTHER_USER_ID,
        roleSlugs: [WORKSPACE_ROLE_SLUGS.MEMBER],
        status: "active",
        lastEventAt: t0,
      })
      await WorkspaceUserPermissionsRepository.upsert(pool, {
        workspaceId: OTHER_WORKSPACE_ID,
        workosUserId: USER_ID,
        roleSlugs: [WORKSPACE_ROLE_SLUGS.MEMBER],
        status: "active",
        lastEventAt: t0,
      })
      const rows = await WorkspaceUserPermissionsRepository.listByWorkspace(pool, WORKSPACE_ID)
      expect(rows.map((r) => r.workosUserId).sort()).toEqual([USER_ID, OTHER_USER_ID].sort())
    })
  })
})
