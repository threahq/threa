import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { HttpError, StubWorkosOrgService } from "@threahq/backend-common"
import { WORKSPACE_ROLE_SLUGS } from "@threahq/types"
import { BackofficeService } from "../../src/features/backoffice/service"
import { setupTestDatabase } from "./setup"

/**
 * The Members tab's "Pending invitations" section reads through
 * `BackofficeService.listWorkspaceInvitations`. The contract:
 *   - only `status='pending'` and non-expired rows surface,
 *   - both `kind='email'` and `kind='link'` are returned (link rows have
 *     `email: null`),
 *   - `role_slug` is preserved on the wire,
 *   - inviter user is resolved via WorkOS, with graceful null fallback.
 */
describe("BackofficeService.listWorkspaceInvitations", () => {
  let pool: Pool
  let workos: StubWorkosOrgService
  let service: BackofficeService

  const region = "us-east-1"
  const workspaceId = "ws_invitations_test"
  const orgId = "org_invitations_test"
  const inviterUserId = "user_inviter_for_invs"

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query("TRUNCATE invitation_shadows, workspace_registry CASCADE")
    workos = new StubWorkosOrgService()
    service = new BackofficeService({
      pool,
      workosOrgService: workos,
      workspaceAppBaseUrl: "",
      workosEnvironmentId: null,
    })

    workos.users.set(inviterUserId, {
      id: inviterUserId,
      email: "inviter@example.com",
      firstName: "In",
      lastName: "Viter",
    })

    await pool.query(
      `INSERT INTO workspace_registry (id, name, slug, region, created_by_workos_user_id, workos_organization_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [workspaceId, "Inv Test", "inv-test", region, inviterUserId, orgId]
    )
  })

  async function seedShadow(params: {
    id: string
    kind: "email" | "link"
    email: string | null
    roleSlug?: string
    status?: "pending" | "accepted" | "revoked"
    expiresInDays?: number
    inviterWorkosUserId?: string | null
  }) {
    await pool.query(
      `INSERT INTO invitation_shadows
        (id, workspace_id, kind, email, region, expires_at, role_slug, status, inviter_workos_user_id, token_hash)
       VALUES ($1, $2, $3, $4, $5, NOW() + ($6 || ' days')::INTERVAL, $7, $8, $9, $10)`,
      [
        params.id,
        workspaceId,
        params.kind,
        params.email,
        region,
        String(params.expiresInDays ?? 7),
        params.roleSlug ?? WORKSPACE_ROLE_SLUGS.MEMBER,
        params.status ?? "pending",
        params.inviterWorkosUserId === null ? null : (params.inviterWorkosUserId ?? inviterUserId),
        params.kind === "link" ? `h_${params.id}` : null,
      ]
    )
  }

  test("returns pending email and link invitations with role_slug and resolved inviter", async () => {
    await seedShadow({
      id: "inv_email_admin",
      kind: "email",
      email: "bob@example.com",
      roleSlug: WORKSPACE_ROLE_SLUGS.ADMIN,
    })
    await seedShadow({
      id: "inv_link_member",
      kind: "link",
      email: null,
      roleSlug: WORKSPACE_ROLE_SLUGS.MEMBER,
    })

    const invitations = await service.listWorkspaceInvitations(workspaceId)

    expect(invitations).toContainEqual(
      expect.objectContaining({
        id: "inv_email_admin",
        kind: "email",
        email: "bob@example.com",
        roleSlug: WORKSPACE_ROLE_SLUGS.ADMIN,
        inviter: expect.objectContaining({
          workosUserId: inviterUserId,
          email: "inviter@example.com",
          name: "In Viter",
        }),
      })
    )
    expect(invitations).toContainEqual(
      expect.objectContaining({
        id: "inv_link_member",
        kind: "link",
        email: null,
        roleSlug: WORKSPACE_ROLE_SLUGS.MEMBER,
      })
    )
  })

  test("excludes accepted, revoked, and expired invitations", async () => {
    await seedShadow({ id: "inv_pending", kind: "email", email: "ok@example.com" })
    await seedShadow({ id: "inv_accepted", kind: "email", email: "done@example.com", status: "accepted" })
    await seedShadow({ id: "inv_revoked", kind: "email", email: "no@example.com", status: "revoked" })
    await seedShadow({ id: "inv_expired", kind: "email", email: "old@example.com", expiresInDays: -1 })

    const invitations = await service.listWorkspaceInvitations(workspaceId)

    expect(invitations.map((i) => i.id)).toEqual(["inv_pending"])
  })

  test("returns inviter: null when the shadow has no inviter recorded", async () => {
    await seedShadow({
      id: "inv_no_inviter",
      kind: "email",
      email: "anon@example.com",
      inviterWorkosUserId: null,
    })

    const invitations = await service.listWorkspaceInvitations(workspaceId)

    expect(invitations).toContainEqual(expect.objectContaining({ id: "inv_no_inviter", inviter: null }))
  })

  test("returns inviter with null name/email when the WorkOS user lookup misses", async () => {
    await seedShadow({
      id: "inv_unknown_inviter",
      kind: "email",
      email: "missing-inviter@example.com",
      inviterWorkosUserId: "user_unknown",
    })

    const invitations = await service.listWorkspaceInvitations(workspaceId)

    expect(invitations).toContainEqual(
      expect.objectContaining({
        id: "inv_unknown_inviter",
        inviter: { workosUserId: "user_unknown", email: null, name: null },
      })
    )
  })

  test("throws 404 when the workspace does not exist", async () => {
    let caught: unknown
    try {
      await service.listWorkspaceInvitations("ws_does_not_exist")
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(HttpError)
    expect((caught as HttpError).status).toBe(404)
  })
})
