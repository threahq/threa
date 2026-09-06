import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { WORKSPACE_ROLE_SLUGS } from "@threahq/types"
import { WorkspaceAuthzService, WorkspaceUserPermissionsRepository } from "../../src/features/workspace-authz"
import { setupTestDatabase } from "./setup"

const WORKSPACE_ID = "ws_authz_service_test"
const USER_ID = "workos_user_authz_service_test"

describe("WorkspaceAuthzService", () => {
  let pool: Pool
  let service: WorkspaceAuthzService

  beforeAll(async () => {
    pool = await setupTestDatabase()
    service = new WorkspaceAuthzService({ pool })
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query("DELETE FROM workspace_user_permissions WHERE workspace_id = $1", [WORKSPACE_ID])
  })

  describe("applyMembershipChange", () => {
    test("upserts a new mirror row", async () => {
      const t0 = new Date("2026-01-01T00:00:00Z")
      await service.applyMembershipChange({
        workspaceId: WORKSPACE_ID,
        workosUserId: USER_ID,
        roleSlugs: [WORKSPACE_ROLE_SLUGS.ADMIN],
        status: "active",
        lastEventAt: t0,
      })

      const persisted = await WorkspaceUserPermissionsRepository.getByWorkspaceAndUser(pool, WORKSPACE_ID, USER_ID)
      expect(persisted).not.toBeNull()
      expect(persisted!.roleSlugs).toEqual([WORKSPACE_ROLE_SLUGS.ADMIN])
      expect(persisted!.status).toBe("active")
      expect(persisted!.lastEventAt).toEqual(t0)
    })

    test("ignores stale changes via the timestamp guard", async () => {
      const t0 = new Date("2026-01-01T00:00:00Z")
      const tStale = new Date("2025-12-31T00:00:00Z")
      await service.applyMembershipChange({
        workspaceId: WORKSPACE_ID,
        workosUserId: USER_ID,
        roleSlugs: [WORKSPACE_ROLE_SLUGS.ADMIN],
        status: "active",
        lastEventAt: t0,
      })

      await service.applyMembershipChange({
        workspaceId: WORKSPACE_ID,
        workosUserId: USER_ID,
        roleSlugs: [WORKSPACE_ROLE_SLUGS.MEMBER],
        status: "active",
        lastEventAt: tStale,
      })

      const persisted = await WorkspaceUserPermissionsRepository.getByWorkspaceAndUser(pool, WORKSPACE_ID, USER_ID)
      expect(persisted!.roleSlugs).toEqual([WORKSPACE_ROLE_SLUGS.ADMIN])
    })
  })

  describe("applyMembershipRemoval", () => {
    test("removes the row when the deletion event is newer", async () => {
      const t0 = new Date("2026-01-01T00:00:00Z")
      const t1 = new Date("2026-01-01T00:00:30Z")
      await service.applyMembershipChange({
        workspaceId: WORKSPACE_ID,
        workosUserId: USER_ID,
        roleSlugs: [WORKSPACE_ROLE_SLUGS.ADMIN],
        status: "active",
        lastEventAt: t0,
      })

      await service.applyMembershipRemoval({
        workspaceId: WORKSPACE_ID,
        workosUserId: USER_ID,
        eventCreatedAt: t1,
      })

      expect(await WorkspaceUserPermissionsRepository.getByWorkspaceAndUser(pool, WORKSPACE_ID, USER_ID)).toBeNull()
    })

    test("ignores a stale removal event", async () => {
      const t0 = new Date("2026-01-01T00:00:00Z")
      const tStale = new Date("2025-12-31T00:00:00Z")
      await service.applyMembershipChange({
        workspaceId: WORKSPACE_ID,
        workosUserId: USER_ID,
        roleSlugs: [WORKSPACE_ROLE_SLUGS.ADMIN],
        status: "active",
        lastEventAt: t0,
      })

      await service.applyMembershipRemoval({
        workspaceId: WORKSPACE_ID,
        workosUserId: USER_ID,
        eventCreatedAt: tStale,
      })

      expect(await WorkspaceUserPermissionsRepository.getByWorkspaceAndUser(pool, WORKSPACE_ID, USER_ID)).not.toBeNull()
    })

    test("is a no-op when no row exists", async () => {
      await service.applyMembershipRemoval({
        workspaceId: WORKSPACE_ID,
        workosUserId: USER_ID,
        eventCreatedAt: new Date("2026-01-01T00:00:00Z"),
      })

      expect(await WorkspaceUserPermissionsRepository.getByWorkspaceAndUser(pool, WORKSPACE_ID, USER_ID)).toBeNull()
    })
  })
})
