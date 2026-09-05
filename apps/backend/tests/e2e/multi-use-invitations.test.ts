import { describe, expect, test } from "bun:test"
import type {
  ClaimInvitationLinkResponse,
  CreateInvitationLinkResponse,
  UpdateInvitationLinkResponse,
  WorkspaceInvitation,
} from "@threa/types"
import { createWorkspace, loginAs, TestClient } from "../client"

const runId = crypto.randomUUID().slice(0, 8)

describe("multi-use invitation API", () => {
  test("should reject join limits outside PostgreSQL integer range", async () => {
    const admin = new TestClient()
    await loginAs(admin, `invite-limit-${runId}@test.com`, "Invite Admin")
    const workspace = await createWorkspace(admin, `Invite limits ${runId}`)
    const path = `/api/workspaces/${workspace.id}/invitations`
    const invalidCreate = await admin.post(`${path}/links`, { role: "member", maxUses: 2_147_483_648 })
    expect(invalidCreate.status).toBe(400)
    const created = await admin.post<CreateInvitationLinkResponse>(`${path}/links`, { role: "member" })
    const invalidEdit = await admin.patch(`${path}/${created.data.invitation.id}`, { maxUses: 2_147_483_648 })
    expect(invalidEdit.status).toBe(400)
    expect(created.data.invitation).not.toHaveProperty("acceptanceConsumesCapacity")
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

    const updated = await admin.patch<UpdateInvitationLinkResponse>(
      `/api/workspaces/${workspace.id}/invitations/${created.data.invitation.id}`,
      { maxUses: 2, expiresAt: null }
    )
    expect(updated).toMatchObject({
      status: 200,
      data: { invitation: { id: created.data.invitation.id, maxUses: 2, useCount: 0, expiresAt: null } },
    })

    const email = `invite-joiner-${runId}@test.com`
    const claimed = await admin.internalRequest<ClaimInvitationLinkResponse>(
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
