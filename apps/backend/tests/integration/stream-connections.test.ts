import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { StreamConnectionErrorCodes, StreamTypes, type StreamConnectionSnapshot, type StreamType } from "@threahq/types"
import { streamConnectionId } from "@threahq/backend-common"
import { setupTestDatabase, addTestMember } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamMemberRepository, StreamRepository } from "../../src/features/streams"
import { E2eStreamsRepository } from "../../src/features/e2e-streams"
import { FeatureFlagOverrideRepository, FeatureFlagService } from "../../src/features/feature-flags"
import { StreamConnectionService } from "../../src/features/stream-connections"
import { StreamConnectionRepository } from "../../src/features/stream-connections/repository"
import { ControlPlaneClient } from "../../src/lib/control-plane-client"
import { streamId, userId, workspaceId } from "../../src/lib/id"

interface CpRequest {
  path: string
  body: unknown
}

/** Answers each control-plane call with the next queued response and records what it was sent. */
function startStubControlPlane() {
  const requests: CpRequest[] = []
  const responses: Array<{ status: number; body: unknown }> = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      requests.push({ path: new URL(req.url).pathname, body: await req.json() })
      const next = responses.shift()
      if (!next) return Response.json({ error: "No stub response queued" }, { status: 500 })
      return Response.json(next.body, { status: next.status })
    },
  })
  return {
    url: `http://localhost:${server.port}`,
    requests,
    respond(status: number, body: unknown) {
      responses.push({ status, body })
    },
    reset() {
      requests.length = 0
      responses.length = 0
    },
    stop: () => server.stop(true),
  }
}

describe("StreamConnectionService", () => {
  let pool: Pool
  let cp: ReturnType<typeof startStubControlPlane>
  let service: StreamConnectionService

  async function seedWorkspace(name: string, flag: "on" | "off" = "on") {
    const id = workspaceId()
    await WorkspaceRepository.insert(pool, { id, name, slug: `strconn-${id}`, createdBy: userId() })
    const admin = await addTestMember(pool, id, `admin-${id}`, "admin")
    await FeatureFlagOverrideRepository.replaceForSubject(pool, id, "workspace", id, { streamConnections: flag })
    return { id, name, adminId: admin.id }
  }

  async function seedStream(wsId: string, createdBy: string, type: StreamType = StreamTypes.CHANNEL) {
    const id = streamId()
    return StreamRepository.insert(pool, {
      id,
      workspaceId: wsId,
      type,
      slug: `launch-${id.slice(-6).toLowerCase()}`,
      displayName: "Launch",
      visibility: "public",
      createdBy,
    })
  }

  function snapshot(
    host: { id: string; name: string },
    hostStreamId: string,
    overrides: Partial<StreamConnectionSnapshot> = {}
  ): StreamConnectionSnapshot {
    return {
      id: streamConnectionId(),
      revision: 1,
      state: "invited",
      hostWorkspaceId: host.id,
      hostWorkspaceName: host.name,
      hostRegion: "eu",
      hostStreamId,
      hostStreamSlug: "launch",
      hostStreamDisplayName: "Launch",
      partnerWorkspaceId: null,
      partnerWorkspaceName: null,
      partnerRegion: null,
      partnerVisibility: null,
      invitedByUserId: "usr_host_admin",
      acceptedByUserId: null,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      ...overrides,
    }
  }

  function activated(invited: StreamConnectionSnapshot, partner: { id: string; name: string }) {
    return {
      ...invited,
      revision: invited.revision + 1,
      state: "active" as const,
      partnerWorkspaceId: partner.id,
      partnerWorkspaceName: partner.name,
      partnerRegion: "eu",
      partnerVisibility: "private" as const,
      acceptedByUserId: "usr_partner_admin",
    }
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
    cp = startStubControlPlane()
    service = new StreamConnectionService({
      pool,
      controlPlaneClient: new ControlPlaneClient(cp.url, "test-key"),
      featureFlagService: new FeatureFlagService(pool),
    })
  })

  beforeEach(() => cp.reset())

  afterAll(async () => {
    cp.stop()
    await pool.end()
  })

  test("should project a new link on the host and list it for the channel", async () => {
    const host = await seedWorkspace("Acme")
    const stream = await seedStream(host.id, host.adminId)
    const invited = snapshot(host, stream.id)
    cp.respond(201, { snapshot: invited, token: "tok_secret", superseded: null })

    const result = await service.createInvite({ workspaceId: host.id, streamId: stream.id, userId: host.adminId })

    const connection = {
      id: invited.id,
      role: "host",
      state: "invited",
      streamId: stream.id,
      streamSlug: "launch",
      streamDisplayName: "Launch",
      remoteWorkspaceId: null,
      remoteWorkspaceName: null,
      partnerVisibility: null,
      expiresAt: invited.expiresAt,
    }
    expect({
      result,
      sent: cp.requests,
      listed: await service.listForStream({ workspaceId: host.id, streamId: stream.id, userId: host.adminId }),
    }).toEqual({
      result: { connection, token: "tok_secret" },
      sent: [
        {
          path: "/internal/stream-connections",
          body: {
            hostWorkspaceId: host.id,
            hostStreamId: stream.id,
            hostStreamSlug: stream.slug,
            hostStreamDisplayName: "Launch",
            invitedByUserId: host.adminId,
          },
        },
      ],
      listed: [connection],
    })
  })

  test("should replace the pending link in the list when a new one is minted", async () => {
    const host = await seedWorkspace("Acme")
    const stream = await seedStream(host.id, host.adminId)
    const first = snapshot(host, stream.id)
    await service.applySnapshot(first)
    const second = snapshot(host, stream.id)
    cp.respond(201, { snapshot: second, token: "tok_2", superseded: { ...first, state: "revoked", revision: 2 } })

    await service.createInvite({ workspaceId: host.id, streamId: stream.id, userId: host.adminId })

    const listed = await service.listForStream({ workspaceId: host.id, streamId: stream.id, userId: host.adminId })
    expect(listed.map((c) => c.id)).toEqual([second.id])
  })

  test("should project both sides when host and partner live in this region", async () => {
    const host = await seedWorkspace("Acme")
    const partner = await seedWorkspace("Globex")
    const stream = await seedStream(host.id, host.adminId)
    const invited = snapshot(host, stream.id)
    await service.applySnapshot(invited)
    const active = activated(invited, partner)
    cp.respond(200, { snapshot: active })

    const accepted = await service.accept({
      workspaceId: partner.id,
      userId: partner.adminId,
      token: "tok_secret",
      visibility: "private",
    })

    const common = {
      id: invited.id,
      state: "active",
      streamId: stream.id,
      streamSlug: "launch",
      streamDisplayName: "Launch",
      partnerVisibility: "private",
      expiresAt: invited.expiresAt,
    }
    const partnerView = { ...common, role: "partner", remoteWorkspaceId: host.id, remoteWorkspaceName: "Acme" }
    expect({
      accepted,
      sent: cp.requests,
      host: await StreamConnectionRepository.listLiveForStream(pool, host.id, stream.id),
      partner: await StreamConnectionRepository.listLiveForStream(pool, partner.id, stream.id),
    }).toEqual({
      accepted: partnerView,
      sent: [
        {
          path: "/internal/stream-connections/accept",
          body: {
            token: "tok_secret",
            partnerWorkspaceId: partner.id,
            acceptedByUserId: partner.adminId,
            visibility: "private",
          },
        },
      ],
      host: [{ ...common, role: "host", remoteWorkspaceId: partner.id, remoteWorkspaceName: "Globex" }],
      partner: [partnerView],
    })
  })

  test("should keep the newer state when an older snapshot arrives late", async () => {
    const host = await seedWorkspace("Acme")
    const partner = await seedWorkspace("Globex")
    const stream = await seedStream(host.id, host.adminId)
    const invited = snapshot(host, stream.id)

    await service.applySnapshot(activated(invited, partner))
    await service.applySnapshot(invited)

    const listed = await StreamConnectionRepository.listLiveForStream(pool, host.id, stream.id)
    expect(listed.map((c) => ({ state: c.state, remote: c.remoteWorkspaceId }))).toEqual([
      { state: "active", remote: partner.id },
    ])
  })

  test("should drop the link from the list once the host revokes it", async () => {
    const host = await seedWorkspace("Acme")
    const stream = await seedStream(host.id, host.adminId)
    const invited = snapshot(host, stream.id)
    await service.applySnapshot(invited)
    cp.respond(200, { snapshot: { ...invited, state: "revoked", revision: 2 } })

    const revoked = await service.revokeInvite({ workspaceId: host.id, connectionId: invited.id })

    expect({
      state: revoked.state,
      sent: cp.requests,
      listed: await service.listForStream({ workspaceId: host.id, streamId: stream.id, userId: host.adminId }),
    }).toEqual({
      state: "revoked",
      sent: [{ path: `/internal/stream-connections/${invited.id}/revoke`, body: { hostWorkspaceId: host.id } }],
      listed: [],
    })
  })

  test("should refuse a snapshot whose workspaces live in another region", async () => {
    const elsewhere = { id: workspaceId(), name: "Elsewhere" }

    await expect(service.applySnapshot(snapshot(elsewhere, streamId()))).rejects.toMatchObject({
      status: 404,
      code: "WORKSPACE_NOT_FOUND",
    })
  })

  test("should refuse to share a DM, a thread, an archived channel, or an encrypted channel", async () => {
    const host = await seedWorkspace("Acme")
    const dm = await seedStream(host.id, host.adminId, StreamTypes.DM)
    const channel = await seedStream(host.id, host.adminId)
    const thread = await StreamRepository.insert(pool, {
      id: streamId(),
      workspaceId: host.id,
      type: StreamTypes.THREAD,
      parentStreamId: channel.id,
      rootStreamId: channel.id,
      createdBy: host.adminId,
    })
    const archived = await seedStream(host.id, host.adminId)
    await pool.query("UPDATE streams SET archived_at = NOW() WHERE id = $1", [archived.id])
    const sealed = await seedStream(host.id, host.adminId)
    await E2eStreamsRepository.markStreamE2e(pool, {
      streamId: sealed.id,
      workspaceId: host.id,
      ownerUserId: host.adminId,
      ownerUserKeyId: "e2ek_owner",
    })
    await StreamMemberRepository.insert(pool, dm.id, host.adminId)

    const outcomes = await Promise.allSettled(
      [dm, thread, archived, sealed].map((s) =>
        service.createInvite({ workspaceId: host.id, streamId: s.id, userId: host.adminId })
      )
    )

    expect({
      codes: outcomes.map((o) => (o.status === "rejected" ? (o.reason as { code: string }).code : "shared")),
      sent: cp.requests,
    }).toEqual({ codes: Array(4).fill(StreamConnectionErrorCodes.NOT_SHAREABLE), sent: [] })
  })

  test("should hide every action while the workspace flag is off", async () => {
    const host = await seedWorkspace("Acme", "off")
    const stream = await seedStream(host.id, host.adminId)
    const ids = { workspaceId: host.id, streamId: stream.id, userId: host.adminId }

    const outcomes = await Promise.allSettled([
      service.createInvite(ids),
      service.listForStream(ids),
      service.revokeInvite({ workspaceId: host.id, connectionId: streamConnectionId() }),
      service.accept({ workspaceId: host.id, userId: host.adminId, token: "tok", visibility: "public" }),
    ])

    expect(outcomes.map((o) => (o.status === "rejected" ? (o.reason as { status: number; code: string }) : o))).toEqual(
      Array(4).fill(expect.objectContaining({ status: 404, code: StreamConnectionErrorCodes.DISABLED }))
    )
    expect(cp.requests).toEqual([])
  })

  test("should pass the control plane's refusal through with its code", async () => {
    const host = await seedWorkspace("Acme")
    const stream = await seedStream(host.id, host.adminId)
    cp.respond(409, { error: "Channel already shared", code: StreamConnectionErrorCodes.ALREADY_SHARED })

    await expect(
      service.createInvite({ workspaceId: host.id, streamId: stream.id, userId: host.adminId })
    ).rejects.toMatchObject({ status: 409, code: StreamConnectionErrorCodes.ALREADY_SHARED })
  })
})
