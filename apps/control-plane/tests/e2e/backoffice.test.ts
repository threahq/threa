import { describe, test, expect } from "bun:test"
import { Pool } from "pg"
import { waitlistId } from "@threa/backend-common"
import { TestClient, loginAs, createWorkspace } from "../client"
import { PlatformRoleRepository } from "../../src/features/backoffice"
import { WaitlistRepository } from "../../src/features/waitlist"
import { WorkosAuthzRepository } from "../../src/features/workos-authz"
import { WorkspaceRegistryRepository } from "../../src/features/workspaces"
import { CONTROL_PLANE_LISTENER_ID } from "../../src/lib/outbox-listeners"

/**
 * Opens a short-lived pool to seed a platform-admin row directly. Tests run in
 * the same process as the control-plane (see setup.ts), so going through the
 * repository is the most direct way to grant admin without a dedicated
 * internal API for it.
 */
async function grantAdmin(workosUserId: string): Promise<void> {
  const pool = new Pool({
    connectionString:
      process.env.TEST_DATABASE_URL || "postgresql://threa:threa@localhost:5454/threa_control_plane_test",
  })
  try {
    await PlatformRoleRepository.upsert(pool, workosUserId, "admin")
  } finally {
    await pool.end()
  }
}

/**
 * Seed a single membership row into the mirror so the members endpoint has
 * something to return. Mirrors the backfill path — `last_event_id` is null and
 * `last_event_at` is the observed timestamp.
 */
async function seedMembership(input: {
  workspaceId: string
  workosUserId: string
  status: "active" | "inactive" | "pending"
  roleSlugs: string[]
}): Promise<{ workosOrganizationId: string; lastEventAt: Date }> {
  const pool = new Pool({
    connectionString:
      process.env.TEST_DATABASE_URL || "postgresql://threa:threa@localhost:5454/threa_control_plane_test",
  })
  try {
    const ws = await WorkspaceRegistryRepository.findById(pool, input.workspaceId)
    if (!ws?.workos_organization_id) {
      throw new Error(`Test setup: workspace ${input.workspaceId} has no workos_organization_id`)
    }
    const observedAt = new Date()
    await WorkosAuthzRepository.upsertMembershipFromBackfill(pool, {
      organizationMembershipId: `om_${input.workosUserId}_${input.workspaceId}`,
      workosOrganizationId: ws.workos_organization_id,
      workosUserId: input.workosUserId,
      status: input.status,
      roleSlugs: input.roleSlugs,
      observedAt,
    })
    return { workosOrganizationId: ws.workos_organization_id, lastEventAt: observedAt }
  } finally {
    await pool.end()
  }
}

/** Insert a single waitlist signup directly, mirroring the public signup path. */
async function seedWaitlistEntry(email: string, source: string | null): Promise<void> {
  const pool = new Pool({
    connectionString:
      process.env.TEST_DATABASE_URL || "postgresql://threa:threa@localhost:5454/threa_control_plane_test",
  })
  try {
    await WaitlistRepository.insert(pool, { id: waitlistId(), email, source })
  } finally {
    await pool.end()
  }
}

describe("Backoffice", () => {
  describe("GET /api/backoffice/me", () => {
    test("returns 401 without session", async () => {
      const client = new TestClient()
      const res = await client.get("/api/backoffice/me")
      expect(res.status).toBe(401)
    })

    test("returns user with isPlatformAdmin=false for non-admin", async () => {
      const client = new TestClient()
      await loginAs(client, "backoffice-nonadmin@example.com", "Non Admin")

      const res = await client.get<{
        id: string
        email: string
        name: string
        isPlatformAdmin: boolean
      }>("/api/backoffice/me")

      expect(res.status).toBe(200)
      expect(res.data.email).toBe("backoffice-nonadmin@example.com")
      expect(res.data.isPlatformAdmin).toBe(false)
    })

    test("returns user with isPlatformAdmin=true for admin", async () => {
      const client = new TestClient()
      const user = await loginAs(client, "backoffice-admin@example.com", "Platform Admin")
      await grantAdmin(user.id)

      const res = await client.get<{ isPlatformAdmin: boolean; email: string }>("/api/backoffice/me")
      expect(res.status).toBe(200)
      expect(res.data.email).toBe("backoffice-admin@example.com")
      expect(res.data.isPlatformAdmin).toBe(true)
    })
  })

  describe("POST /api/backoffice/workspace-owner-invitations", () => {
    test("returns 401 without session", async () => {
      const client = new TestClient()
      const res = await client.post("/api/backoffice/workspace-owner-invitations", {
        email: "new-owner@example.com",
      })
      expect(res.status).toBe(401)
    })

    test("returns 403 when authenticated but not a platform admin", async () => {
      const client = new TestClient()
      await loginAs(client, "invite-nonadmin@example.com", "Not Admin")

      const res = await client.post<{ code: string }>("/api/backoffice/workspace-owner-invitations", {
        email: "would-be-owner@example.com",
      })
      expect(res.status).toBe(403)
      expect(res.data.code).toBe("NOT_PLATFORM_ADMIN")
    })

    test("returns 400 for invalid email", async () => {
      const client = new TestClient()
      const user = await loginAs(client, "invite-admin-bad@example.com", "Admin Bad Email")
      await grantAdmin(user.id)

      const res = await client.post<{ code: string }>("/api/backoffice/workspace-owner-invitations", {
        email: "not-an-email",
      })
      expect(res.status).toBe(400)
      expect(res.data.code).toBe("VALIDATION_ERROR")
    })

    test("creates an invitation when called by a platform admin", async () => {
      const client = new TestClient()
      const user = await loginAs(client, "invite-admin@example.com", "Inviter Admin")
      await grantAdmin(user.id)

      const res = await client.post<{
        invitation: { id: string; email: string; expiresAt: string }
      }>("/api/backoffice/workspace-owner-invitations", {
        email: "brand-new-owner@example.com",
      })

      expect(res.status).toBe(201)
      expect(res.data.invitation.email).toBe("brand-new-owner@example.com")
      expect(res.data.invitation.id).toBeTruthy()
      expect(() => new Date(res.data.invitation.expiresAt).toISOString()).not.toThrow()
    })
  })

  describe("GET /api/backoffice/workspace-owner-invitations", () => {
    test("returns 403 when authenticated but not a platform admin", async () => {
      const client = new TestClient()
      await loginAs(client, "invites-list-nonadmin@example.com", "List Non Admin")

      const res = await client.get<{ code: string }>("/api/backoffice/workspace-owner-invitations")
      expect(res.status).toBe(403)
      expect(res.data.code).toBe("NOT_PLATFORM_ADMIN")
    })

    test("lists previously sent invitations for a platform admin", async () => {
      const client = new TestClient()
      const user = await loginAs(client, "invites-list-admin@example.com", "List Admin")
      await grantAdmin(user.id)

      const postRes = await client.post<{
        invitation: { id: string; email: string }
      }>("/api/backoffice/workspace-owner-invitations", {
        email: "list-seed@example.com",
      })
      expect(postRes.status).toBe(201)

      const listRes = await client.get<{
        invitations: Array<{ id: string; email: string; state: string }>
      }>("/api/backoffice/workspace-owner-invitations")

      expect(listRes.status).toBe(200)
      const found = listRes.data.invitations.find((i) => i.id === postRes.data.invitation.id)
      expect(found).toBeTruthy()
      expect(found?.email).toBe("list-seed@example.com")
      expect(found?.state).toBe("pending")
    })
  })

  describe("GET /api/backoffice/workspaces", () => {
    test("returns 403 when authenticated but not a platform admin", async () => {
      const client = new TestClient()
      await loginAs(client, "workspaces-list-nonadmin@example.com", "Workspaces Non Admin")

      const res = await client.get<{ code: string }>("/api/backoffice/workspaces")
      expect(res.status).toBe(403)
      expect(res.data.code).toBe("NOT_PLATFORM_ADMIN")
    })

    test("returns an array for a platform admin", async () => {
      const client = new TestClient()
      const user = await loginAs(client, "workspaces-list-admin@example.com", "Workspaces Admin")
      await grantAdmin(user.id)

      const res = await client.get<{
        workspaces: Array<{ id: string; name: string; slug: string; region: string; memberCount: number }>
      }>("/api/backoffice/workspaces")

      expect(res.status).toBe(200)
      expect(Array.isArray(res.data.workspaces)).toBe(true)
    })
  })

  describe("GET /api/backoffice/workspaces/:id/members", () => {
    test("returns 401 without session", async () => {
      const client = new TestClient()
      const res = await client.get("/api/backoffice/workspaces/ws_anything/members")
      expect(res.status).toBe(401)
    })

    test("returns 403 when authenticated but not a platform admin", async () => {
      const client = new TestClient()
      await loginAs(client, "members-nonadmin@example.com", "Members Non Admin")

      const res = await client.get<{ code: string }>("/api/backoffice/workspaces/ws_anything/members")
      expect(res.status).toBe(403)
      expect(res.data.code).toBe("NOT_PLATFORM_ADMIN")
    })

    test("returns 404 when workspace does not exist", async () => {
      const client = new TestClient()
      const user = await loginAs(client, "members-admin-404@example.com", "Members Admin 404")
      await grantAdmin(user.id)

      const res = await client.get<{ code: string }>("/api/backoffice/workspaces/ws_does_not_exist/members")
      expect(res.status).toBe(404)
      expect(res.data.code).toBe("NOT_FOUND")
    })

    test("returns an empty members array when the mirror has no rows yet", async () => {
      const client = new TestClient()
      const user = await loginAs(client, "members-admin@example.com", "Members Admin")
      await grantAdmin(user.id)

      // Stub auth provisions a WorkOS organization on workspace creation, but
      // the mirror is empty until backfill or events run. The route should
      // still return an empty array, not 404.
      const ws = await createWorkspace(client, "Members Test")
      const res = await client.get<{
        members: unknown[]
      }>(`/api/backoffice/workspaces/${ws.id}/members`)

      expect(res.status).toBe(200)
      expect(res.data.members).toEqual([])
    })

    test("returns mirror-shaped rows with the contract the frontend expects", async () => {
      const client = new TestClient()
      const user = await loginAs(client, "members-shape-admin@example.com", "Members Shape Admin")
      await grantAdmin(user.id)

      const ws = await createWorkspace(client, "Members Shape Test")
      const seedUserId = `user_seed_${Date.now()}`
      const { lastEventAt } = await seedMembership({
        workspaceId: ws.id,
        workosUserId: seedUserId,
        status: "active",
        roleSlugs: ["admin", "member"],
      })

      const res = await client.get<{
        members: Array<{
          workosUserId: string
          email: string | null
          firstName: string | null
          lastName: string | null
          status: string
          roleSlugs: string[]
          lastEventAt: string
        }>
      }>(`/api/backoffice/workspaces/${ws.id}/members`)

      expect(res.status).toBe(200)
      expect(res.data.members).toHaveLength(1)
      const [row] = res.data.members
      // Mirror-derived fields are exact.
      expect(row.workosUserId).toBe(seedUserId)
      expect(row.status).toBe("active")
      expect(row.roleSlugs).toEqual(["admin", "member"])
      // Best-effort enrichment: stub doesn't know this user, so email/name are null.
      // The contract is "nullable", not "always present" — assert the type, not a value.
      expect(row.email === null || typeof row.email === "string").toBe(true)
      expect(row.firstName === null || typeof row.firstName === "string").toBe(true)
      expect(row.lastName === null || typeof row.lastName === "string").toBe(true)
      // lastEventAt is an ISO string round-trippable to the seeded Date.
      expect(typeof row.lastEventAt).toBe("string")
      expect(new Date(row.lastEventAt).toISOString()).toBe(lastEventAt.toISOString())
    })
  })

  describe("POST /api/backoffice/workspaces/:id/members/resync", () => {
    test("returns 401 without session", async () => {
      const client = new TestClient()
      const res = await client.post("/api/backoffice/workspaces/ws_anything/members/resync")
      expect(res.status).toBe(401)
    })

    test("returns 403 when authenticated but not a platform admin", async () => {
      const client = new TestClient()
      await loginAs(client, "resync-nonadmin@example.com", "Resync Non Admin")

      const res = await client.post<{ code: string }>("/api/backoffice/workspaces/ws_anything/members/resync")
      expect(res.status).toBe(403)
      expect(res.data.code).toBe("NOT_PLATFORM_ADMIN")
    })

    test("returns 404 when workspace does not exist", async () => {
      const client = new TestClient()
      const user = await loginAs(client, "resync-admin-404@example.com", "Resync Admin 404")
      await grantAdmin(user.id)

      const res = await client.post<{ code: string }>("/api/backoffice/workspaces/ws_does_not_exist/members/resync")
      expect(res.status).toBe(404)
      expect(res.data.code).toBe("NOT_FOUND")
    })

    test("returns result shape for a linked workspace (zero changes when stub has no memberships)", async () => {
      const client = new TestClient()
      const user = await loginAs(client, "resync-admin@example.com", "Resync Admin")
      await grantAdmin(user.id)

      const ws = await createWorkspace(client, "Resync Test")
      const res = await client.post<{
        result: { membershipsUpserted: number; membershipsRemoved: number; outboxEventIds: string[] }
      }>(`/api/backoffice/workspaces/${ws.id}/members/resync`)

      expect(res.status).toBe(200)
      expect(typeof res.data.result.membershipsUpserted).toBe("number")
      expect(typeof res.data.result.membershipsRemoved).toBe("number")
      // outboxEventIds is required for the UI's propagation polling. Empty
      // when the stub has no memberships; should always be an array.
      expect(Array.isArray(res.data.result.outboxEventIds)).toBe(true)
    })
  })

  describe("GET /api/backoffice/outbox-events/status", () => {
    test("returns 401 without session", async () => {
      const client = new TestClient()
      const res = await client.get("/api/backoffice/outbox-events/status?ids=1,2,3")
      expect(res.status).toBe(401)
    })

    test("returns 403 when authenticated but not a platform admin", async () => {
      const client = new TestClient()
      await loginAs(client, "outbox-status-nonadmin@example.com", "Outbox Status Non Admin")

      const res = await client.get<{ code: string }>("/api/backoffice/outbox-events/status?ids=1")
      expect(res.status).toBe(403)
      expect(res.data.code).toBe("NOT_PLATFORM_ADMIN")
    })

    test("returns empty statuses for empty ids query", async () => {
      const client = new TestClient()
      const user = await loginAs(client, "outbox-status-admin-empty@example.com", "Outbox Status Admin")
      await grantAdmin(user.id)

      const res = await client.get<{ statuses: Array<{ id: string; status: string }> }>(
        "/api/backoffice/outbox-events/status"
      )
      expect(res.status).toBe(200)
      expect(res.data.statuses).toEqual([])
    })

    test("returns 400 for non-numeric ids", async () => {
      const client = new TestClient()
      const user = await loginAs(client, "outbox-status-admin-bad@example.com", "Outbox Status Admin")
      await grantAdmin(user.id)

      const res = await client.get<{ code: string }>("/api/backoffice/outbox-events/status?ids=not-a-number")
      expect(res.status).toBe(400)
      expect(res.data.code).toBe("VALIDATION_ERROR")
    })

    test("returns processed status for ids the control-plane listener has drained", async () => {
      const client = new TestClient()
      const user = await loginAs(client, "outbox-status-admin@example.com", "Outbox Status Admin")
      await grantAdmin(user.id)

      // The control-plane listener bootstrap runs `ensureListenerFromLatest`,
      // so anything inserted before will sit at or below `last_processed_id`
      // and read back as `processed` — a low-fidelity but stable signal.
      const pool = new Pool({
        connectionString:
          process.env.TEST_DATABASE_URL || "postgresql://threa:threa@localhost:5454/threa_control_plane_test",
      })
      try {
        const row = await pool.query<{ id: string }>(
          `INSERT INTO outbox (event_type, payload) VALUES ('test_outbox_status', '{}'::jsonb) RETURNING id::text AS id`
        )
        const eventId = row.rows[0]!.id
        await pool.query(
          `INSERT INTO outbox_listeners (listener_id, last_processed_id, processed_ids)
             VALUES ($2, $1::bigint, '{}'::jsonb)
             ON CONFLICT (listener_id) DO UPDATE SET last_processed_id = GREATEST(outbox_listeners.last_processed_id, EXCLUDED.last_processed_id)`,
          [eventId, CONTROL_PLANE_LISTENER_ID]
        )

        const res = await client.get<{ statuses: Array<{ id: string; status: string }> }>(
          `/api/backoffice/outbox-events/status?ids=${eventId}`
        )
        expect(res.status).toBe(200)
        expect(res.data.statuses).toEqual([{ id: eventId, status: "processed" }])
      } finally {
        await pool.end()
      }
    })
  })

  describe("GET /api/backoffice/waitlist", () => {
    test("returns 401 without session", async () => {
      const client = new TestClient()
      const res = await client.get("/api/backoffice/waitlist")
      expect(res.status).toBe(401)
    })

    test("returns 403 when authenticated but not a platform admin", async () => {
      const client = new TestClient()
      await loginAs(client, "waitlist-nonadmin@example.com", "Waitlist Non Admin")

      const res = await client.get<{ code: string }>("/api/backoffice/waitlist")
      expect(res.status).toBe(403)
      expect(res.data.code).toBe("NOT_PLATFORM_ADMIN")
    })

    test("returns recent signups and exact counts for a platform admin", async () => {
      const client = new TestClient()
      const user = await loginAs(client, "waitlist-admin@example.com", "Waitlist Admin")
      await grantAdmin(user.id)

      const seededEmail = `waitlist-seed-${Date.now()}@example.com`
      await seedWaitlistEntry(seededEmail, "marketing-hero")

      const res = await client.get<{
        waitlist: {
          entries: Array<{ id: string; email: string; source: string | null; status: string; createdAt: string }>
          stats: { total: number; pending: number; invited: number }
          truncated: boolean
        }
      }>("/api/backoffice/waitlist")

      expect(res.status).toBe(200)
      const seeded = res.data.waitlist.entries.find((e) => e.email === seededEmail)
      expect(seeded).toBeTruthy()
      expect(seeded?.source).toBe("marketing-hero")
      // New signups default to pending and carry a round-trippable ISO timestamp.
      expect(seeded?.status).toBe("pending")
      expect(new Date(seeded!.createdAt).toISOString()).toBe(seeded!.createdAt)
      // Counts are computed in the DB, so they cover at least the row we seeded.
      expect(res.data.waitlist.stats.total).toBeGreaterThanOrEqual(1)
      expect(res.data.waitlist.stats.pending).toBeGreaterThanOrEqual(1)
      expect(typeof res.data.waitlist.truncated).toBe("boolean")
    })
  })

  describe("Idempotency", () => {
    test("granting admin twice leaves the user as admin", async () => {
      const client = new TestClient()
      const user = await loginAs(client, "idem-admin@example.com", "Idem Admin")

      await grantAdmin(user.id)
      await grantAdmin(user.id)

      const res = await client.get<{ isPlatformAdmin: boolean }>("/api/backoffice/me")
      expect(res.status).toBe(200)
      expect(res.data.isPlatformAdmin).toBe(true)
    })
  })
})
