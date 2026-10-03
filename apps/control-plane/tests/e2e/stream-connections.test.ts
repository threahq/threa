import { describe, expect, test } from "bun:test"
import { StreamConnectionErrorCodes, type StreamConnectionSnapshot } from "@threahq/types"
import { TestClient, createWorkspace, loginAs } from "../client"

interface Minted {
  snapshot: StreamConnectionSnapshot
  token: string
}

async function mint(client: TestClient, hostWorkspaceId: string, hostStreamId: string): Promise<Minted> {
  const res = await client.internalRequest<Minted>("POST", "/internal/stream-connections", {
    hostWorkspaceId,
    hostStreamId,
    invitedBy: "usr_inviter",
  })
  expect(res.status).toBe(201)
  return res.data
}

describe("Stream connection routes", () => {
  test("should refuse every internal route without the internal key", async () => {
    const client = new TestClient()

    const statuses = await Promise.all([
      client.post("/internal/stream-connections", { hostWorkspaceId: "ws_x", hostStreamId: "s", invitedBy: "u" }),
      client.post("/internal/stream-connections/accept", {
        token: "t",
        partnerWorkspaceId: "ws_x",
        visibility: "public",
        acceptedBy: "u",
      }),
      client.post("/internal/stream-connections/list", { workspaceId: "ws_x", streamId: "s", includeIds: [] }),
      client.post("/internal/stream-connections/conn_x/revoke", { hostWorkspaceId: "ws_x" }),
    ])

    expect(statuses.map((res) => res.status)).toEqual([401, 401, 401, 401])
  })

  test("should mint, show, accept and list a link across the internal and session routes", async () => {
    const hostAdmin = new TestClient()
    await loginAs(hostAdmin, "connect-host@example.com", "Host Admin")
    const host = await createWorkspace(hostAdmin, "Connect Host")
    const partnerAdmin = new TestClient()
    await loginAs(partnerAdmin, "connect-partner@example.com", "Partner Admin")
    const partner = await createWorkspace(partnerAdmin, "Connect Partner")
    const streamId = `stream_routes_${crypto.randomUUID()}`

    const { snapshot, token } = await mint(hostAdmin, host.id, streamId)
    const signedOut = await new TestClient().get(`/api/stream-connections/lookup?token=${token}`)
    const lookup = await partnerAdmin.get(`/api/stream-connections/lookup?token=${token}`)
    const accepted = await partnerAdmin.internalRequest<{ snapshot: StreamConnectionSnapshot }>(
      "POST",
      "/internal/stream-connections/accept",
      { token, partnerWorkspaceId: partner.id, visibility: "private", acceptedBy: "usr_partner_admin" }
    )
    const listed = await partnerAdmin.internalRequest("POST", "/internal/stream-connections/list", {
      workspaceId: partner.id,
      streamId,
      includeIds: [snapshot.id],
    })
    const partnerAfter = await partnerAdmin.get(`/api/stream-connections/lookup?token=${token}`)
    const hostAfter = await hostAdmin.get(`/api/stream-connections/lookup?token=${token}`)

    expect({
      signedOut: signedOut.status,
      lookup: { status: lookup.status, cache: lookup.headers.get("cache-control"), data: lookup.data },
      accepted: { status: accepted.status, state: accepted.data.snapshot.state },
      listed: { status: listed.status, data: listed.data },
      partnerAfter: { status: partnerAfter.status, data: partnerAfter.data },
      hostAfter: { status: hostAfter.status, data: hostAfter.data },
    }).toEqual({
      signedOut: 401,
      lookup: {
        status: 200,
        cache: "no-store",
        data: {
          state: "invited",
          hostWorkspaceId: host.id,
          hostWorkspaceName: "Connect Host",
          hostRegion: host.region,
          streamDisplayName: "Launch",
          streamSlug: "launch",
          partnerWorkspaceId: null,
          partnerWorkspaceName: null,
          partners: [],
        },
      },
      accepted: { status: 200, state: "active" },
      listed: { status: 200, data: { snapshots: [accepted.data.snapshot] } },
      partnerAfter: {
        status: 200,
        data: {
          state: "active",
          hostWorkspaceId: host.id,
          hostWorkspaceName: "Connect Host",
          hostRegion: host.region,
          streamDisplayName: "Launch",
          streamSlug: "launch",
          partnerWorkspaceId: partner.id,
          partnerWorkspaceName: "Connect Partner",
        },
      },
      hostAfter: { status: 409, data: expect.objectContaining({ code: StreamConnectionErrorCodes.ALREADY_ACCEPTED }) },
    })
  })

  test("should revoke a pending link and refuse to revoke it from another workspace", async () => {
    const admin = new TestClient()
    await loginAs(admin, "connect-revoker@example.com", "Revoker")
    const host = await createWorkspace(admin, "Connect Revoker")
    const { snapshot } = await mint(admin, host.id, `stream_revoke_${crypto.randomUUID()}`)

    const foreign = await admin.internalRequest("POST", `/internal/stream-connections/${snapshot.id}/revoke`, {
      hostWorkspaceId: "ws_someone_else",
    })
    const revoked = await admin.internalRequest<{ snapshot: StreamConnectionSnapshot }>(
      "POST",
      `/internal/stream-connections/${snapshot.id}/revoke`,
      { hostWorkspaceId: host.id }
    )

    expect({
      foreign: { status: foreign.status, data: foreign.data },
      revoked: { status: revoked.status, snapshot: revoked.data.snapshot },
    }).toEqual({
      foreign: { status: 404, data: expect.objectContaining({ code: StreamConnectionErrorCodes.NOT_FOUND }) },
      revoked: { status: 200, snapshot: { ...snapshot, state: "revoked", revision: 2 } },
    })
  })
})
