import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import {
  StreamConnectionErrorCodes,
  StreamTypes,
  type StreamConnectionSnapshot,
  type StreamType,
  type Visibility,
} from "@threahq/types"
import { streamConnectionId } from "@threahq/backend-common"
import { setupTestDatabase, addTestMember } from "./setup"
import { UserRepository, WorkspaceRepository } from "../../src/features/workspaces"
import { WorkspaceUserPermissionsRepository } from "../../src/features/workspace-authz"
import { StreamMemberRepository, StreamRepository } from "../../src/features/streams"
import { E2eStreamsRepository } from "../../src/features/e2e-streams"
import { FeatureFlagOverrideRepository, FeatureFlagService } from "../../src/features/feature-flags"
import { StreamConnectionService } from "../../src/features/stream-connections"
import { StreamConnectionRepository } from "../../src/features/stream-connections/repository"
import { ControlPlaneClient } from "../../src/lib/control-plane-client"
import type { StreamConnectionUpdatedOutboxPayload } from "../../src/lib/outbox"
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
      const url = new URL(req.url)
      requests.push({ path: url.pathname + url.search, body: req.method === "GET" ? null : await req.json() })
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

  async function seedStream(
    wsId: string,
    createdBy: string,
    type: StreamType = StreamTypes.CHANNEL,
    visibility: Visibility = "public"
  ) {
    const id = streamId()
    return StreamRepository.insert(pool, {
      id,
      workspaceId: wsId,
      type,
      slug: `launch-${id.slice(-6).toLowerCase()}`,
      displayName: "Launch",
      visibility,
      createdBy,
    })
  }

  async function connectionEvents(workspaceIds: string[]) {
    const result = await pool.query<{ payload: StreamConnectionUpdatedOutboxPayload }>(
      `SELECT payload FROM outbox
       WHERE event_type = 'stream_connection:updated' AND payload->>'workspaceId' = ANY($1)
       ORDER BY id`,
      [workspaceIds]
    )
    return result.rows.map((row) => row.payload)
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
      invitedBy: "usr_inviter",
      partnerWorkspaceId: null,
      partnerWorkspaceName: null,
      partnerRegion: null,
      partnerVisibility: null,
      acceptedBy: null,
      peerWorkspaceIds: [],
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      ...overrides,
    }
  }

  function activated(
    invited: StreamConnectionSnapshot,
    partner: { id: string; name: string },
    peerWorkspaceIds: string[] = []
  ): StreamConnectionSnapshot {
    return {
      ...invited,
      revision: invited.revision + 1,
      state: "active",
      partnerWorkspaceId: partner.id,
      partnerWorkspaceName: partner.name,
      partnerRegion: "eu",
      partnerVisibility: "private",
      acceptedBy: "usr_accepter",
      peerWorkspaceIds,
    }
  }

  /** A row as one workspace sees it. Only the host's row names the inviter, and only the partner's the accepter and its visibility. */
  function seenBy(
    connection: StreamConnectionSnapshot,
    role: "host" | "partner" | "peer",
    remote: { id: string; name: string } | null
  ) {
    return {
      id: connection.id,
      role,
      state: connection.state,
      revision: connection.revision,
      streamId: connection.hostStreamId,
      remoteWorkspaceId: remote?.id ?? null,
      remoteWorkspaceName: remote?.name ?? null,
      partnerVisibility: role === "partner" ? connection.partnerVisibility : null,
      invitedBy: role === "host" ? connection.invitedBy : null,
      acceptedBy: role === "partner" ? connection.acceptedBy : null,
      expiresAt: connection.expiresAt,
    }
  }

  const byId = <T extends { id: string }>(rows: T[]) => rows.toSorted((a, b) => a.id.localeCompare(b.id))

  function listRequest(workspaceId: string, streamId: string, includeIds: string[]) {
    return { path: "/internal/stream-connections/list", body: { workspaceId, streamId, includeIds } }
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
    cp.respond(201, { snapshot: invited, token: "tok_secret" })
    cp.respond(200, { snapshots: [invited] })

    const result = await service.createInvite({ workspaceId: host.id, streamId: stream.id, userId: host.adminId })
    const minted = [...cp.requests]
    const listed = await service.listForStream({ workspaceId: host.id, streamId: stream.id, userId: host.adminId })

    const connection = seenBy(invited, "host", null)
    // The channel is re-read from the control plane on every list, in case a sync never arrived.
    expect({ result, minted, listed, repaired: cp.requests.slice(minted.length) }).toEqual({
      result: { connection, token: "tok_secret" },
      minted: [
        {
          path: "/internal/stream-connections",
          body: {
            hostWorkspaceId: host.id,
            hostStreamId: stream.id,
            invitedBy: host.adminId,
          },
        },
      ],
      listed: [connection],
      repaired: [listRequest(host.id, stream.id, [invited.id])],
    })
  })

  test("should list the channel's partners and every working link, newest first", async () => {
    const host = await seedWorkspace("Acme")
    const stream = await seedStream(host.id, host.adminId)
    const partner = { id: workspaceId(), name: "Globex" }
    // Ids minted in one millisecond don't sort by creation, so mint them in order.
    const [first, second, third] = [streamConnectionId(), streamConnectionId(), streamConnectionId()].toSorted()
    const accepted = { ...activated(snapshot(host, stream.id, { id: first }), partner), partnerRegion: "us" }
    const older = snapshot(host, stream.id, { id: second })
    const newer = snapshot(host, stream.id, { id: third })
    const lapsed = snapshot(host, stream.id, { expiresAt: new Date(Date.now() - 60_000).toISOString() })
    for (const s of [accepted, older, newer, lapsed]) await service.applySnapshot(s)
    cp.respond(200, { snapshots: [accepted, older, newer] })

    const listed = await service.listForStream({ workspaceId: host.id, streamId: stream.id, userId: host.adminId })

    expect({ listed: listed.map((c) => [c.id, c.state]), sent: cp.requests }).toEqual({
      listed: [
        [newer.id, "invited"],
        [older.id, "invited"],
        [accepted.id, "active"],
      ],
      sent: [listRequest(host.id, stream.id, [newer.id, older.id, accepted.id])],
    })
  })

  test("should show a link accepted just before it lapsed when this region missed the accept", async () => {
    const host = await seedWorkspace("Acme")
    const stream = await seedStream(host.id, host.adminId)
    const lapsed = snapshot(host, stream.id, { expiresAt: new Date(Date.now() - 60_000).toISOString() })
    await service.applySnapshot(lapsed)
    const remotePartner = { id: workspaceId(), name: "Globex" }
    const accepted = { ...activated(lapsed, remotePartner), partnerRegion: "us" }
    cp.respond(200, { snapshots: [accepted] })

    const listed = await service.listForStream({ workspaceId: host.id, streamId: stream.id, userId: host.adminId })

    expect({ listed, sent: cp.requests }).toEqual({
      listed: [seenBy(accepted, "host", remotePartner)],
      sent: [listRequest(host.id, stream.id, [])],
    })
  })

  test("should list the local rows when the control plane can't answer", async () => {
    const host = await seedWorkspace("Acme")
    const stream = await seedStream(host.id, host.adminId)
    const invited = snapshot(host, stream.id)
    await service.applySnapshot(invited)
    cp.respond(503, { error: "Unavailable" })

    const listed = await service.listForStream({ workspaceId: host.id, streamId: stream.id, userId: host.adminId })

    expect(listed).toEqual([seenBy(invited, "host", null)])
  })

  test("should fail the listing when the control plane rejects the request instead of hiding it behind local rows", async () => {
    const host = await seedWorkspace("Acme")
    const stream = await seedStream(host.id, host.adminId)
    await service.applySnapshot(snapshot(host, stream.id))
    cp.respond(401, { error: "Unauthorized" })

    await expect(
      service.listForStream({ workspaceId: host.id, streamId: stream.id, userId: host.adminId })
    ).rejects.toMatchObject({ status: 502, code: "CONTROL_PLANE_REJECTED" })
  })

  test("should heal an accept the control plane never delivered when the host lists a pending link", async () => {
    const host = await seedWorkspace("Acme")
    const stream = await seedStream(host.id, host.adminId)
    const invited = snapshot(host, stream.id)
    await service.applySnapshot(invited)
    const remotePartner = { id: workspaceId(), name: "Globex" }
    const accepted = { ...activated(invited, remotePartner), partnerRegion: "us" }
    cp.respond(200, { snapshots: [accepted] })

    const listed = await service.listForStream({ workspaceId: host.id, streamId: stream.id, userId: host.adminId })

    const event = (connection: StreamConnectionSnapshot, remote: { id: string; name: string } | null) => ({
      workspaceId: host.id,
      streamId: stream.id,
      streamVisibility: "public",
      adminMemberUserIds: [],
      connection: seenBy(connection, "host", remote),
    })
    expect({ listed, sent: cp.requests, events: await connectionEvents([host.id]) }).toEqual({
      listed: [seenBy(accepted, "host", remotePartner)],
      sent: [listRequest(host.id, stream.id, [invited.id])],
      events: [event(invited, null), event(accepted, remotePartner)],
    })
  })

  test("should fail the list when the control plane answers with something it doesn't understand", async () => {
    const host = await seedWorkspace("Acme")
    const stream = await seedStream(host.id, host.adminId)
    cp.respond(200, { bogus: true })

    await expect(
      service.listForStream({ workspaceId: host.id, streamId: stream.id, userId: host.adminId })
    ).rejects.toMatchObject({ name: "ZodError" })
  })

  test("should show a workspace that joined while this region missed the sync", async () => {
    const host = await seedWorkspace("Acme")
    const stream = await seedStream(host.id, host.adminId)
    const second = { id: workspaceId(), name: "Globex" }
    const third = { id: workspaceId(), name: "Initech" }
    const toSecond = { ...activated(snapshot(host, stream.id), second), partnerRegion: "us" }
    await service.applySnapshot(toSecond)
    const toThird = { ...activated(snapshot(host, stream.id), third, [second.id]), partnerRegion: "us" }
    cp.respond(200, { snapshots: [{ ...toSecond, peerWorkspaceIds: [third.id] }, toThird] })

    const listed = await service.listForStream({ workspaceId: host.id, streamId: stream.id, userId: host.adminId })

    expect({ listed: byId(listed), sent: cp.requests }).toEqual({
      listed: byId([seenBy(toSecond, "host", second), seenBy(toThird, "host", third)]),
      sent: [listRequest(host.id, stream.id, [toSecond.id])],
    })
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

    const partnerView = seenBy(active, "partner", host)
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
            visibility: "private",
            acceptedBy: partner.adminId,
          },
        },
      ],
      host: [seenBy(active, "host", partner)],
      partner: [partnerView],
    })
  })

  test("should answer with the newer projection when the control plane's reply is already stale", async () => {
    const host = await seedWorkspace("Acme")
    const partner = await seedWorkspace("Globex")
    const stream = await seedStream(host.id, host.adminId)
    const active = activated(snapshot(host, stream.id), partner)
    const newer = { ...active, revision: active.revision + 1, partnerVisibility: "public" as const }
    await service.applySnapshot(newer)
    cp.respond(200, { snapshot: active })

    const accepted = await service.accept({
      workspaceId: partner.id,
      userId: partner.adminId,
      token: "tok_secret",
      visibility: "private",
    })

    expect(accepted).toEqual(seenBy(newer, "partner", host))
  })

  test("should give every workspace in a three-way channel its own row for each connection", async () => {
    const host = await seedWorkspace("Acme")
    const second = await seedWorkspace("Globex")
    const third = await seedWorkspace("Initech")
    const stream = await seedStream(host.id, host.adminId)
    const toSecond = activated(snapshot(host, stream.id), second, [third.id])
    const toThird = activated(snapshot(host, stream.id), third, [second.id])

    await StreamConnectionRepository.applySnapshots(pool, [toSecond, toThird])

    const seen = async (ws: { id: string }) =>
      byId(await StreamConnectionRepository.listLiveForStream(pool, ws.id, stream.id))
    expect({ host: await seen(host), second: await seen(second), third: await seen(third) }).toEqual({
      host: byId([seenBy(toSecond, "host", second), seenBy(toThird, "host", third)]),
      second: byId([seenBy(toSecond, "partner", host), seenBy(toThird, "peer", third)]),
      third: byId([seenBy(toThird, "partner", host), seenBy(toSecond, "peer", second)]),
    })
  })

  test("should project a peer row in a region that holds neither the host nor the connection's partner", async () => {
    const remoteHost = { id: workspaceId(), name: "Acme" }
    const remotePartner = { id: workspaceId(), name: "Globex" }
    const peer = await seedWorkspace("Initech")
    const hostStreamId = streamId()
    const active = {
      ...activated(snapshot(remoteHost, hostStreamId), remotePartner, [peer.id]),
      hostRegion: "us",
      partnerRegion: "us",
    }

    await service.applySnapshot(active)

    expect(await StreamConnectionRepository.listLiveForStream(pool, peer.id, hostStreamId)).toEqual([
      seenBy(active, "peer", remotePartner),
    ])
  })

  test("should keep a peer row's newer state when an older snapshot arrives late", async () => {
    const remoteHost = { id: workspaceId(), name: "Acme" }
    const remotePartner = { id: workspaceId(), name: "Globex" }
    const peer = await seedWorkspace("Initech")
    const hostStreamId = streamId()
    const active = {
      ...activated(snapshot(remoteHost, hostStreamId), remotePartner, [peer.id]),
      hostRegion: "us",
      partnerRegion: "us",
    }
    const renamed = { ...active, revision: active.revision + 1, partnerWorkspaceName: "Globex Corp" }

    await service.applySnapshot(renamed)
    await service.applySnapshot(active)

    expect(await StreamConnectionRepository.listLiveForStream(pool, peer.id, hostStreamId)).toEqual([
      seenBy(renamed, "peer", { id: remotePartner.id, name: "Globex Corp" }),
    ])
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
    cp.respond(200, { snapshots: [] })

    const revoked = await service.revokeInvite({ workspaceId: host.id, connectionId: invited.id, userId: host.adminId })

    expect({
      state: revoked.state,
      sent: cp.requests,
      listed: await service.listForStream({ workspaceId: host.id, streamId: stream.id, userId: host.adminId }),
    }).toEqual({
      state: "revoked",
      sent: [
        { path: `/internal/stream-connections/${invited.id}/revoke`, body: { hostWorkspaceId: host.id } },
        listRequest(host.id, stream.id, []),
      ],
      listed: [],
    })
  })

  test("should refuse a revoke from the partner's side, and any action from an admin who can't see the channel", async () => {
    const host = await seedWorkspace("Acme")
    const partner = await seedWorkspace("Globex")
    const outsider = await addTestMember(pool, host.id, `admin2-${host.id}`, "admin")
    const stream = await seedStream(host.id, host.adminId, StreamTypes.CHANNEL, "private")
    await StreamMemberRepository.insert(pool, stream.id, host.adminId)
    const pending = snapshot(host, stream.id)
    const joined = activated(snapshot(host, stream.id), partner)
    for (const s of [pending, joined]) await service.applySnapshot(s)

    const outcomes = await Promise.allSettled([
      service.revokeInvite({ workspaceId: partner.id, connectionId: joined.id, userId: partner.adminId }),
      service.revokeInvite({ workspaceId: host.id, connectionId: pending.id, userId: outsider.id }),
      service.createInvite({ workspaceId: host.id, streamId: stream.id, userId: outsider.id }),
      service.listForStream({ workspaceId: host.id, streamId: stream.id, userId: outsider.id }),
    ])

    expect({
      refusals: outcomes.map((o) => (o.status === "rejected" ? (o.reason as { status: number; code: string }) : o)),
      sent: cp.requests,
    }).toEqual({
      refusals: [
        expect.objectContaining({ status: 404, code: StreamConnectionErrorCodes.NOT_FOUND }),
        ...Array(3).fill(expect.objectContaining({ status: 404, code: "STREAM_NOT_FOUND" })),
      ],
      sent: [],
    })
  })

  test("should project only the host side when the partner lives in another region", async () => {
    const host = await seedWorkspace("Acme")
    const stream = await seedStream(host.id, host.adminId)
    const remotePartner = { id: workspaceId(), name: "Globex" }
    const active = { ...activated(snapshot(host, stream.id), remotePartner), partnerRegion: "us" }

    await service.applySnapshot(active)

    expect({
      host: await StreamConnectionRepository.listLiveForStream(pool, host.id, stream.id),
      partner: await StreamConnectionRepository.listLiveForStream(pool, remotePartner.id, stream.id),
    }).toEqual({
      host: [seenBy(active, "host", remotePartner)],
      partner: [],
    })
  })

  test("should project only the partner side when the host lives in another region", async () => {
    const remoteHost = { id: workspaceId(), name: "Acme" }
    const partner = await seedWorkspace("Globex")
    const remoteStreamId = streamId()
    const active = { ...activated(snapshot(remoteHost, remoteStreamId), partner), hostRegion: "us" }

    await service.applySnapshot(active)

    expect({
      host: await StreamConnectionRepository.listLiveForStream(pool, remoteHost.id, remoteStreamId),
      partner: await StreamConnectionRepository.listLiveForStream(pool, partner.id, remoteStreamId),
    }).toEqual({
      host: [],
      partner: [seenBy(active, "partner", remoteHost)],
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

  test("should name the channel and call it shareable only while it is an active, unencrypted channel with sharing on", async () => {
    const host = await seedWorkspace("Acme")
    const switchedOff = await seedWorkspace("Initech", "off")
    const channel = await seedStream(host.id, host.adminId)
    const dm = await seedStream(host.id, host.adminId, StreamTypes.DM)
    const archived = await seedStream(host.id, host.adminId)
    await pool.query("UPDATE streams SET archived_at = NOW() WHERE id = $1", [archived.id])
    const sealed = await seedStream(host.id, host.adminId)
    await E2eStreamsRepository.markStreamE2e(pool, {
      streamId: sealed.id,
      workspaceId: host.id,
      ownerUserId: host.adminId,
      ownerUserKeyId: "e2ek_owner",
    })
    const offChannel = await seedStream(switchedOff.id, switchedOff.adminId)

    const inHost = { workspaceId: host.id, invitedBy: host.adminId }
    const answers = await Promise.all([
      service.describeChannel({ ...inHost, streamId: channel.id }),
      service.describeChannel({ ...inHost, streamId: dm.id }),
      service.describeChannel({ ...inHost, streamId: archived.id }),
      service.describeChannel({ ...inHost, streamId: sealed.id }),
      service.describeChannel({ ...inHost, streamId: streamId() }),
      service.describeChannel({ ...inHost, streamId: offChannel.id }),
      service.describeChannel({ workspaceId: switchedOff.id, streamId: offChannel.id, invitedBy: switchedOff.adminId }),
    ])

    const named = (stream: { slug: string | null }, shareable: boolean) => ({
      shareable,
      slug: stream.slug,
      displayName: "Launch",
    })
    const unknown = { shareable: false, slug: null, displayName: null }
    expect(answers).toEqual([
      named(channel, true),
      named(dm, false),
      named(archived, false),
      named(sealed, false),
      unknown,
      unknown,
      named(offChannel, false),
    ])
  })

  test("should stop calling a channel shareable once the link's creator is demoted, deactivated, removed, or out of the private channel", async () => {
    const host = await seedWorkspace("Acme")
    const publicChannel = await seedStream(host.id, host.adminId)
    const privateChannel = await seedStream(host.id, host.adminId, StreamTypes.CHANNEL, "private")
    const [stillAdmin, demoted, deactivated, removed, leftChannel, neverMember] = await Promise.all(
      ["still", "demoted", "deactivated", "removed", "left", "never"].map((name) =>
        addTestMember(pool, host.id, `${name}-${host.id}`, "admin")
      )
    )
    for (const user of [stillAdmin, leftChannel]) await StreamMemberRepository.insert(pool, privateChannel.id, user.id)
    for (const user of [stillAdmin, leftChannel, neverMember]) {
      await WorkspaceUserPermissionsRepository.upsert(pool, {
        workspaceId: host.id,
        workosUserId: user.workosUserId,
        roleSlugs: ["admin"],
        status: "active",
        lastEventAt: new Date(),
      })
    }
    await WorkspaceUserPermissionsRepository.upsert(pool, {
      workspaceId: host.id,
      workosUserId: demoted.workosUserId,
      roleSlugs: ["member"],
      status: "active",
      lastEventAt: new Date(),
    })
    await WorkspaceUserPermissionsRepository.upsert(pool, {
      workspaceId: host.id,
      workosUserId: deactivated.workosUserId,
      roleSlugs: ["admin"],
      status: "inactive",
      lastEventAt: new Date(),
    })
    await UserRepository.remove(pool, host.id, removed.id)
    await StreamMemberRepository.delete(pool, privateChannel.id, leftChannel.id)

    const shareable = async (streamId: string, invitedBy: string) =>
      (await service.describeChannel({ workspaceId: host.id, streamId, invitedBy })).shareable
    const answers = {
      stillAdmin: await shareable(privateChannel.id, stillAdmin.id),
      demoted: await shareable(publicChannel.id, demoted.id),
      deactivated: await shareable(publicChannel.id, deactivated.id),
      removed: await shareable(publicChannel.id, removed.id),
      leftChannel: await shareable(privateChannel.id, leftChannel.id),
      neverMember: await shareable(privateChannel.id, neverMember.id),
      neverMemberOnPublic: await shareable(publicChannel.id, neverMember.id),
    }

    expect(answers).toEqual({
      stillAdmin: true,
      demoted: false,
      deactivated: false,
      removed: false,
      leftChannel: false,
      neverMember: false,
      neverMemberOnPublic: true,
    })
  })

  test("should treat an admin WorkOS removed as gone once it mirrors the workspace", async () => {
    const host = await seedWorkspace("Acme")
    const stream = await seedStream(host.id, host.adminId)
    const [kept, removed] = await Promise.all(
      ["kept", "removed"].map((name) => addTestMember(pool, host.id, `${name}-${host.id}`, "admin"))
    )
    for (const user of [kept, removed]) {
      await WorkspaceUserPermissionsRepository.upsert(pool, {
        workspaceId: host.id,
        workosUserId: user.workosUserId,
        roleSlugs: ["admin"],
        status: "active",
        lastEventAt: new Date(Date.now() - 60_000),
      })
    }
    const remove = (workosUserId: string) =>
      WorkspaceUserPermissionsRepository.markRemoved(pool, {
        workspaceId: host.id,
        workosUserId,
        eventCreatedAt: new Date(),
      })
    const shareable = async (invitedBy: string) =>
      (await service.describeChannel({ workspaceId: host.id, streamId: stream.id, invitedBy })).shareable

    await remove(removed.workosUserId)
    const answers = {
      kept: await shareable(kept.id),
      removed: await shareable(removed.id),
      removedCreates: await service
        .createInvite({ workspaceId: host.id, streamId: stream.id, userId: removed.id })
        .catch((err: { status: number; code: string }) => ({ status: err.status, code: err.code })),
    }
    await remove(kept.workosUserId)
    const afterLastRemoved = { kept: await shareable(kept.id), removed: await shareable(removed.id) }

    expect({ answers, afterLastRemoved }).toEqual({
      answers: { kept: true, removed: false, removedCreates: { status: 403, code: "FORBIDDEN" } },
      afterLastRemoved: { kept: false, removed: false },
    })
    expect(cp.requests).toEqual([])
  })

  test("should refuse to describe a channel for a workspace this region doesn't hold", async () => {
    await expect(
      service.describeChannel({ workspaceId: workspaceId(), streamId: streamId(), invitedBy: userId() })
    ).rejects.toMatchObject({
      status: 404,
      code: "WORKSPACE_NOT_FOUND",
    })
  })

  test("should hide every action while the workspace flag is off", async () => {
    const host = await seedWorkspace("Acme", "off")
    const stream = await seedStream(host.id, host.adminId)
    const ids = { workspaceId: host.id, streamId: stream.id, userId: host.adminId }

    const outcomes = await Promise.allSettled([
      service.createInvite(ids),
      service.listForStream(ids),
      service.revokeInvite({ workspaceId: host.id, connectionId: streamConnectionId(), userId: host.adminId }),
      service.accept({ workspaceId: host.id, userId: host.adminId, token: "tok", visibility: "public" }),
      service.assertCanAccept({ workspaceId: host.id, userId: host.adminId }),
    ])

    expect(outcomes.map((o) => (o.status === "rejected" ? (o.reason as { status: number; code: string }) : o))).toEqual(
      Array(5).fill(expect.objectContaining({ status: 404, code: StreamConnectionErrorCodes.DISABLED }))
    )
    expect(cp.requests).toEqual([])
  })

  test("should refuse every action from an admin demoted since signing in, before asking the control plane", async () => {
    const host = await seedWorkspace("Acme")
    const stream = await seedStream(host.id, host.adminId)
    const pending = snapshot(host, stream.id)
    await service.applySnapshot(pending)
    const demoted = await addTestMember(pool, host.id, `demoted-${host.id}`, "admin")
    await WorkspaceUserPermissionsRepository.upsert(pool, {
      workspaceId: host.id,
      workosUserId: demoted.workosUserId,
      roleSlugs: ["member"],
      status: "active",
      lastEventAt: new Date(),
    })
    const ids = { workspaceId: host.id, streamId: stream.id, userId: demoted.id }

    const outcomes = await Promise.allSettled([
      service.createInvite(ids),
      service.listForStream(ids),
      service.revokeInvite({ workspaceId: host.id, connectionId: pending.id, userId: demoted.id }),
      service.accept({ workspaceId: host.id, userId: demoted.id, token: "tok", visibility: "public" }),
      service.assertCanAccept({ workspaceId: host.id, userId: demoted.id }),
    ])

    expect(outcomes.map((o) => (o.status === "rejected" ? (o.reason as { status: number; code: string }) : o))).toEqual(
      Array(5).fill(expect.objectContaining({ status: 403, code: "FORBIDDEN" }))
    )
    expect(cp.requests).toEqual([])
  })

  test("should pass the control plane's refusal through with its code", async () => {
    const partner = await seedWorkspace("Globex")
    cp.respond(409, { error: "Already in this channel", code: StreamConnectionErrorCodes.ALREADY_CONNECTED })

    await expect(
      service.accept({ workspaceId: partner.id, userId: partner.adminId, token: "tok", visibility: "public" })
    ).rejects.toMatchObject({ status: 409, code: StreamConnectionErrorCodes.ALREADY_CONNECTED })
  })

  test("should tell a public channel's admins about each change it makes, and nothing on a replay", async () => {
    const host = await seedWorkspace("Acme")
    const partner = await seedWorkspace("Globex")
    const stream = await seedStream(host.id, host.adminId)
    const invited = snapshot(host, stream.id)
    const active = activated(invited, partner)

    for (const s of [invited, active, active, invited]) await service.applySnapshot(s)

    const event = (connection: StreamConnectionSnapshot, remote: { id: string; name: string } | null) => ({
      workspaceId: host.id,
      streamId: stream.id,
      streamVisibility: "public",
      adminMemberUserIds: [],
      connection: seenBy(connection, "host", remote),
    })
    // The partner's row carries the host's stream id, which names no stream of its own workspace.
    expect(await connectionEvents([host.id, partner.id])).toEqual([event(invited, null), event(active, partner)])
  })

  test("should address a private channel's change to the admins who are its members", async () => {
    const host = await seedWorkspace("Acme")
    // An admin outside the channel, and a member who isn't an admin.
    await addTestMember(pool, host.id, `admin2-${host.id}`, "admin")
    const member = await addTestMember(pool, host.id, `member-${host.id}`)
    const stream = await seedStream(host.id, host.adminId, StreamTypes.CHANNEL, "private")
    await StreamMemberRepository.insertMany(pool, stream.id, [host.adminId, member.id])
    const invited = snapshot(host, stream.id)

    await service.applySnapshot(invited)

    expect(await connectionEvents([host.id])).toEqual([
      {
        workspaceId: host.id,
        streamId: stream.id,
        streamVisibility: "private",
        adminMemberUserIds: [host.adminId],
        connection: seenBy(invited, "host", null),
      },
    ])
  })

  test("should tell no one about a private channel no admin belongs to", async () => {
    const host = await seedWorkspace("Acme")
    const member = await addTestMember(pool, host.id, `member-${host.id}`)
    const stream = await seedStream(host.id, member.id, StreamTypes.CHANNEL, "private")
    await StreamMemberRepository.insertMany(pool, stream.id, [member.id])

    await service.applySnapshot(snapshot(host, stream.id))

    expect(await connectionEvents([host.id])).toEqual([])
  })

  test("should answer 502 when the control plane can't be reached", async () => {
    const host = await seedWorkspace("Acme")
    const stream = await seedStream(host.id, host.adminId)
    const unreachable = startStubControlPlane()
    unreachable.stop()
    const isolated = new StreamConnectionService({
      pool,
      controlPlaneClient: new ControlPlaneClient(unreachable.url, "test-key"),
      featureFlagService: new FeatureFlagService(pool),
    })

    await expect(
      isolated.createInvite({ workspaceId: host.id, streamId: stream.id, userId: host.adminId })
    ).rejects.toMatchObject({ status: 502, code: "CONTROL_PLANE_UNAVAILABLE" })
  })
})
