import { describe, expect, test } from "bun:test"
import type { ClaimInvitationLinkResponse, CreateInvitationLinkResponse, WorkspaceInvitation } from "@threa/types"
import { createWorkspace, loginAs, TestClient } from "../client"

const runId = crypto.randomUUID().slice(0, 8)

describe("regional invitation dark compatibility API", () => {
  test("should reject future settings and leave the update route unavailable", async () => {
    const admin = new TestClient()
    await loginAs(admin, `invite-dark-guard-${runId}@test.com`, "Invite Dark Admin")
    const workspace = await createWorkspace(admin, `Invite dark guards ${runId}`)
    const path = `/api/workspaces/${workspace.id}/invitations`

    expect((await admin.post(`${path}/links`, { role: "member", maxUses: 2 })).status).toBe(400)
    expect((await admin.post(`${path}/links`, { role: "member", expiresAt: null })).status).toBe(400)

    const created = await admin.post<CreateInvitationLinkResponse>(`${path}/links`, { role: "member" })
    expect(created.status).toBe(201)
    expect(created.data.invitation).toMatchObject({ maxUses: 1, useCount: 0 })
    expect(created.data.invitation.expiresAt).toEqual(expect.any(String))

    const update = await admin.patch(`${path}/${created.data.invitation.id}`, { maxUses: 2 })
    expect(update.status).toBe(404)
  })

  test("should preserve the legacy create, claim, accept, list, and revoke API", async () => {
    const admin = new TestClient()
    await loginAs(admin, `invite-dark-roundtrip-${runId}@test.com`, "Invite Dark Admin")
    const workspace = await createWorkspace(admin, `Invite dark roundtrip ${runId}`)
    const path = `/api/workspaces/${workspace.id}/invitations`
    const created = await admin.post<CreateInvitationLinkResponse>(`${path}/links`, { role: "member" })
    const email = `invite-dark-joiner-${runId}@test.com`

    const claimed = await admin.internalRequest<ClaimInvitationLinkResponse>(
      "POST",
      "/internal/invitations/claim-link",
      { token: created.data.token, email }
    )
    expect(claimed).toEqual(expect.objectContaining({ status: 200, data: { ok: true } }))
    expect(claimed.data).not.toHaveProperty("invitationId")

    const accepted = await admin.internalRequest<{ workspaceId: string }>(
      "POST",
      `/internal/invitations/${created.data.invitation.id}/accept`,
      { workosUserId: `workos_invite_dark_joiner_${runId}`, email, name: "Invite Dark Joiner" }
    )
    expect(accepted).toEqual(expect.objectContaining({ status: 200, data: { workspaceId: workspace.id } }))

    const listed = await admin.get<{ invitations: WorkspaceInvitation[] }>(path)
    expect(listed.data.invitations.find((invitation) => invitation.id === created.data.invitation.id)).toMatchObject({
      email,
      status: "accepted",
      maxUses: 1,
      useCount: 1,
    })

    const revoked = await admin.post(`${path}/${created.data.invitation.id}/revoke`)
    expect(revoked).toMatchObject({ status: 200, data: { success: true } })
  })
})
