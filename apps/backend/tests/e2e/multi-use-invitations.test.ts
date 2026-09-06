import { describe, expect, test } from "bun:test"
import { Pool } from "pg"
import type { CreateInvitationLinkResponse, UpdateInvitationLinkResponse, WorkspaceInvitation } from "@threa/types"
import { hashInvitationToken } from "../../src/features/invitations/service"
import { invitationId } from "../../src/lib/id"
import { createWorkspace, loginAs, TestClient } from "../client"
import { getTestDatabaseTarget } from "../test-database"

const runId = crypto.randomUUID().slice(0, 8)

describe("multi-use invitation API", () => {
  test("should reject unsupported link settings without partially applying an edit", async () => {
    const admin = new TestClient()
    await loginAs(admin, `invite-schema-${runId}@test.com`, "Invite Admin")
    const workspace = await createWorkspace(admin, `Invite schema ${runId}`)
    const path = `/api/workspaces/${workspace.id}/invitations`
    const invalidCreate = await admin.post(`${path}/links`, { role: "member", maxUse: 10, expireAt: null })
    expect(invalidCreate.status).toBe(400)
    const created = await admin.post<CreateInvitationLinkResponse>(`${path}/links`, { role: "member", maxUses: 2 })
    const invalidEdit = await admin.patch(`${path}/${created.data.invitation.id}`, { maxUses: null, role: "admin" })
    expect(invalidEdit.status).toBe(400)
    const listed = await admin.get<{ invitations: WorkspaceInvitation[] }>(path)
    expect(listed.data.invitations.find((item) => item.id === created.data.invitation.id)).toMatchObject({
      role: "member",
      maxUses: 2,
    })
  })

  test("should reject join limits outside PostgreSQL integer range", async () => {
    const admin = new TestClient()
    await loginAs(admin, `invite-limit-${runId}@test.com`, "Invite Admin")
    const workspace = await createWorkspace(admin, `Invite limits ${runId}`)
    const path = `/api/workspaces/${workspace.id}/invitations`
    const invalidCreate = await admin.post(`${path}/links`, { role: "member", maxUses: 2_147_483_648 })
    expect(invalidCreate.status).toBe(400)
    const privilegedCreate = await admin.post(`${path}/links`, { role: "admin", maxUses: 1 })
    expect(privilegedCreate).toMatchObject({ status: 400, data: { code: "VALIDATION_ERROR" } })
    const created = await admin.post<CreateInvitationLinkResponse>(`${path}/links`, { role: "member" })
    const invalidEdit = await admin.patch(`${path}/${created.data.invitation.id}`, { maxUses: 2_147_483_648 })
    expect(invalidEdit.status).toBe(400)
    expect(created.data.invitation).not.toHaveProperty("acceptanceConsumesCapacity")
  })

  test("should preserve one legacy admin claimant while allowing expiry edits", async () => {
    const admin = new TestClient()
    const adminEmail = `legacy-admin-${runId}@test.com`
    await loginAs(admin, adminEmail, "Legacy Invite Admin")
    const workspace = await createWorkspace(admin, `Legacy admin invite ${runId}`)
    const pool = new Pool({ connectionString: getTestDatabaseTarget().connectionUrl })
    const id = invitationId()
    const token = `legacy-admin-${runId}`
    try {
      const inviter = await pool.query<{ id: string }>(
        "SELECT id FROM users WHERE workspace_id = $1 AND lower(email) = lower($2)",
        [workspace.id, adminEmail]
      )
      await pool.query(
        `INSERT INTO workspace_invitations
           (id, workspace_id, kind, email, role, invited_by, token_hash, status, expires_at, max_uses)
         VALUES ($1, $2, 'link', NULL, 'admin', $3, $4, 'expired', NOW() - INTERVAL '1 day', 1)`,
        [id, workspace.id, inviter.rows[0].id, hashInvitationToken(token)]
      )

      const path = `/api/workspaces/${workspace.id}/invitations/${id}`
      expect(await admin.patch(path, { maxUses: null })).toMatchObject({
        status: 409,
        data: { code: "INVITATION_NOT_EDITABLE" },
      })
      expect(await admin.patch(path, { maxUses: 2 })).toMatchObject({
        status: 409,
        data: { code: "INVITATION_NOT_EDITABLE" },
      })
      const restored = await admin.patch<UpdateInvitationLinkResponse>(path, { expiresAt: null })
      expect(restored).toMatchObject({
        status: 200,
        data: { invitation: { id, role: "admin", maxUses: 1, expiresAt: null } },
      })

      await expect(
        admin.internalRequest("POST", "/internal/invitations/claim-link", {
          token,
          email: "first-admin-claim@example.com",
        })
      ).resolves.toMatchObject({ status: 200, data: { invitationId: id } })
      await expect(
        admin.internalRequest("POST", "/internal/invitations/claim-link", {
          token,
          email: "second-admin-claim@example.com",
        })
      ).resolves.toMatchObject({ status: 409, data: { code: "INVITATION_EXHAUSTED" } })

      const persisted = await pool.query(
        "SELECT email, max_uses, expires_at, revision FROM workspace_invitations WHERE id = $1",
        [id]
      )
      expect(persisted.rows[0]).toMatchObject({ email: "first-admin-claim@example.com", max_uses: 1, expires_at: null })
    } finally {
      await pool.end()
    }
  })

  test("should create, claim, accept, inspect, edit, and revoke one link", async () => {
    const admin = new TestClient()
    await loginAs(admin, `invite-admin-${runId}@test.com`, "Invite Admin")
    const workspace = await createWorkspace(admin, `Invite API ${runId}`)

    const created = await admin.post<CreateInvitationLinkResponse>(
      `/api/workspaces/${workspace.id}/invitations/links`,
      { role: "member", maxUses: null, expiresAt: null }
    )
    expect(created.status).toBe(201)
    expect(created.data.invitation).toMatchObject({
      workspaceId: workspace.id,
      kind: "link",
      email: null,
      maxUses: null,
      useCount: 0,
      expiresAt: null,
    })

    const pastExpiry = new Date(Date.now() - 1000).toISOString()
    expect(
      (await admin.post(`/api/workspaces/${workspace.id}/invitations/links`, { role: "member", expiresAt: pastExpiry }))
        .status
    ).toBe(400)
    expect(
      (
        await admin.patch(`/api/workspaces/${workspace.id}/invitations/${created.data.invitation.id}`, {
          expiresAt: pastExpiry,
        })
      ).status
    ).toBe(400)

    const updated = await admin.patch<UpdateInvitationLinkResponse>(
      `/api/workspaces/${workspace.id}/invitations/${created.data.invitation.id}`,
      { maxUses: 2, expiresAt: null }
    )
    expect(updated).toMatchObject({
      status: 200,
      data: { invitation: { id: created.data.invitation.id, maxUses: 2, useCount: 0, expiresAt: null } },
    })

    const email = `invite-joiner-${runId}@test.com`
    const claimed = await admin.internalRequest<{ ok: true; invitationId: string }>(
      "POST",
      "/internal/invitations/claim-link",
      { token: created.data.token, email }
    )
    expect(claimed).toMatchObject({ status: 200, data: { ok: true } })
    expect(claimed.data.invitationId).toMatch(/^inv_/)

    const accepted = await admin.internalRequest<{ workspaceId: string }>(
      "POST",
      `/internal/invitations/${claimed.data.invitationId}/accept`,
      { workosUserId: `workos_invite_joiner_${runId}`, email, name: "Invite Joiner" }
    )
    expect(accepted).toEqual(expect.objectContaining({ status: 200, data: { workspaceId: workspace.id } }))

    const listed = await admin.get<{ invitations: WorkspaceInvitation[] }>(
      `/api/workspaces/${workspace.id}/invitations`
    )
    expect(listed.status).toBe(200)
    expect(listed.data.invitations.find((invitation) => invitation.id === created.data.invitation.id)).toMatchObject({
      maxUses: 2,
      useCount: 1,
      expiresAt: null,
    })

    const revoked = await admin.post(`/api/workspaces/${workspace.id}/invitations/${created.data.invitation.id}/revoke`)
    expect(revoked).toMatchObject({ status: 200, data: { success: true } })

    const editRevoked = await admin.patch(`/api/workspaces/${workspace.id}/invitations/${created.data.invitation.id}`, {
      maxUses: 3,
    })
    expect(editRevoked).toMatchObject({ status: 409, data: { code: "INVITATION_NOT_EDITABLE" } })
  })
})
