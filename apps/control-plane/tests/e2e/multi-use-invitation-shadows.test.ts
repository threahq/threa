import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { TestClient, createWorkspace, loginAs } from "../client"

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex")

describe("multi-use invitation shadow protocol", () => {
  test("supports unlimited, non-expiring lookup and revisioned updates", async () => {
    const owner = new TestClient()
    await loginAs(owner, "cp-link-owner@example.com", "CP Link Owner")
    const workspace = await createWorkspace(owner, "CP Multi Link")
    const token = "cp-unlimited-no-expiry-token"

    const created = await owner.internalRequest("POST", "/internal/invitation-shadows", {
      id: "inv_cp_unlimited",
      workspaceId: workspace.id,
      region: "local",
      kind: "link",
      email: null,
      tokenHash: tokenHash(token),
      roleSlug: "member",
      expiresAt: null,
      maxUses: null,
      useCount: 0,
      revision: 1,
      status: "pending",
    })
    expect(created.status).toBe(201)

    const lookup = await owner.get<{ workspaceName: string; expiresAt: null }>(
      `/api/invitations/lookup?token=${encodeURIComponent(token)}`
    )
    expect(lookup).toMatchObject({ status: 200, data: { workspaceName: "CP Multi Link", expiresAt: null } })

    expect(
      (
        await owner.internalRequest("PATCH", "/internal/invitation-shadows/inv_cp_unlimited", {
          expiresAt: null,
          maxUses: 3,
          useCount: 1,
          revision: 2,
          status: "accepted",
        })
      ).status
    ).toBe(200)
    expect((await owner.get(`/api/invitations/lookup?token=${encodeURIComponent(token)}`)).status).toBe(200)
  })

  test("reconciles accepted membership through the internal protocol after parent revocation", async () => {
    const owner = new TestClient()
    await loginAs(owner, "cp-recovery-owner@example.com", "CP Recovery Owner")
    const workspace = await createWorkspace(owner, "CP Accepted Recovery")
    const invitee = new TestClient()
    const user = await loginAs(invitee, "cp-recovery@example.com", "CP Recovery")

    await owner.internalRequest("POST", "/internal/invitation-shadows", {
      id: "inv_cp_recovery_parent",
      workspaceId: workspace.id,
      region: "local",
      kind: "link",
      email: null,
      tokenHash: tokenHash("cp-recovery-token"),
      roleSlug: "member",
      expiresAt: null,
      maxUses: 2,
      useCount: 0,
      revision: 1,
      status: "pending",
    })
    await owner.internalRequest("POST", "/internal/invitation-shadows/inv_cp_recovery_parent/claim", {
      childInvitationId: "inv_cp_recovery_child",
      email: user.email,
      expiresAt: null,
      maxUses: 2,
      useCount: 0,
      revision: 1,
    })
    await owner.internalRequest("PATCH", "/internal/invitation-shadows/inv_cp_recovery_parent", {
      expiresAt: null,
      maxUses: 2,
      useCount: 1,
      revision: 2,
      status: "revoked",
    })
    const accepted = await owner.internalRequest(
      "POST",
      "/internal/invitation-shadows/inv_cp_recovery_child/accepted",
      {
        workspaceId: workspace.id,
        email: user.email,
        workosUserId: user.id,
        parentInvitationId: "inv_cp_recovery_parent",
        expiresAt: null,
        maxUses: 2,
        useCount: 1,
        revision: 2,
        status: "revoked",
      }
    )

    expect(accepted.status).toBe(200)
    const listed = await invitee.get<{ workspaces: Array<{ id: string }>; pendingInvitations: unknown[] }>(
      "/api/workspaces"
    )
    expect(listed.data.workspaces).toContainEqual(expect.objectContaining({ id: workspace.id }))
    expect(listed.data.pendingInvitations).toEqual([])
  })

  test("creates separate child shadows and keeps them pending after repeated claim events", async () => {
    const owner = new TestClient()
    await loginAs(owner, "cp-child-owner@example.com", "CP Child Owner")
    const workspace = await createWorkspace(owner, "CP Child Claims")

    await owner.internalRequest("POST", "/internal/invitation-shadows", {
      id: "inv_cp_parent",
      workspaceId: workspace.id,
      region: "local",
      kind: "link",
      email: null,
      tokenHash: tokenHash("cp-child-parent-token"),
      roleSlug: "member",
      expiresAt: null,
      maxUses: null,
      useCount: 0,
      revision: 1,
      status: "pending",
      inviterWorkosUserId: "stub_owner_cp_child",
    })

    for (const [childInvitationId, email] of [
      ["inv_cp_child_one", "cp-child-one@example.com"],
      ["inv_cp_child_two", "cp-child-two@example.com"],
    ]) {
      const claim = await owner.internalRequest("POST", "/internal/invitation-shadows/inv_cp_parent/claim", {
        childInvitationId,
        email,
        expiresAt: null,
        maxUses: null,
        useCount: 0,
        revision: 1,
        inviterWorkosUserId: "stub_owner_cp_child",
      })
      expect(claim.status).toBe(200)
    }

    for (const [id, email] of [
      ["inv_cp_child_one", "cp-child-one@example.com"],
      ["inv_cp_child_two", "cp-child-two@example.com"],
    ]) {
      const invitee = new TestClient()
      await loginAs(invitee, email, email)
      const list = await invitee.get<{ pendingInvitations: Array<{ id: string; expiresAt: null }> }>("/api/workspaces")
      expect(list.data.pendingInvitations).toContainEqual(
        expect.objectContaining({ id, workspaceId: workspace.id, expiresAt: null })
      )
    }
  })
})
