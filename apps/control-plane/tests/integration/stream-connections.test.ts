import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { StreamConnectionErrorCodes } from "@threahq/types"
import {
  OUTBOX_STREAM_CONNECTION_SYNC,
  StreamConnectionService,
  type StreamConnectionSyncPayload,
} from "../../src/features/stream-connections"
import { WorkspaceRegistryRepository } from "../../src/features/workspaces"
import { RegionalClient } from "../../src/lib/regional-client"
import { startMockRegionalBackend, type MockRegionalBackend } from "../mock-regional-backend"
import { setupTestDatabase } from "./setup"

describe("StreamConnectionService", () => {
  let pool: Pool
  let eu: MockRegionalBackend
  let us: MockRegionalBackend
  let service: StreamConnectionService
  const workspaceIds: string[] = []

  async function seedWorkspace(region: string, name: string): Promise<string> {
    const id = `ws_strconn_${crypto.randomUUID().replaceAll("-", "")}`
    workspaceIds.push(id)
    await WorkspaceRegistryRepository.insert(pool, {
      id,
      name,
      slug: id.replaceAll("_", "-"),
      region,
      createdByWorkosUserId: "workos_user_1",
    })
    return id
  }

  function invite(hostWorkspaceId: string, hostStreamId = `stream_${crypto.randomUUID()}`) {
    return service.createInvite({
      hostWorkspaceId,
      hostStreamId,
      hostStreamSlug: "launch",
      hostStreamDisplayName: "Launch",
      invitedByUserId: "usr_host_admin",
    })
  }

  async function syncEvents(connectionId: string): Promise<StreamConnectionSyncPayload[]> {
    const result = await pool.query<{ payload: StreamConnectionSyncPayload }>(
      `SELECT payload FROM outbox WHERE event_type = $1 AND payload->>'connectionId' = $2 ORDER BY id`,
      [OUTBOX_STREAM_CONNECTION_SYNC, connectionId]
    )
    return result.rows.map((r) => r.payload)
  }

  function received(region: MockRegionalBackend) {
    return region.requests.map((r) => ({ url: r.url, body: r.body }))
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
    eu = await startMockRegionalBackend()
    us = await startMockRegionalBackend()
    const regionalClient = new RegionalClient({ eu: { internalUrl: eu.url }, us: { internalUrl: us.url } }, "test-key")
    service = new StreamConnectionService({ pool, regionalClient })
  })

  beforeEach(() => {
    eu.reset()
    us.reset()
  })

  afterAll(async () => {
    await pool.query("DELETE FROM stream_connections WHERE host_workspace_id = ANY($1)", [workspaceIds])
    await pool.query("DELETE FROM workspace_memberships WHERE workspace_id = ANY($1)", [workspaceIds])
    await pool.query("DELETE FROM workspace_registry WHERE id = ANY($1)", [workspaceIds])
    await pool.query("DELETE FROM outbox WHERE event_type = $1", [OUTBOX_STREAM_CONNECTION_SYNC])
    await eu.stop()
    await us.stop()
    await pool.end()
  })

  test("should push a pending invite only to the host region and show it on lookup", async () => {
    const host = await seedWorkspace("eu", "Acme")
    const { snapshot, token } = await invite(host)

    await service.syncToRegions({ connectionId: snapshot.id } satisfies StreamConnectionSyncPayload)

    expect({ eu: received(eu), us: received(us), lookup: await service.lookup(token, "workos_viewer") }).toEqual({
      eu: [{ url: "/internal/stream-connections", body: snapshot }],
      us: [],
      lookup: {
        connectionId: snapshot.id,
        state: "invited",
        hostWorkspaceId: host,
        hostWorkspaceName: "Acme",
        hostRegion: "eu",
        streamDisplayName: "Launch",
        streamSlug: "launch",
        partnerWorkspaceId: null,
        partnerWorkspaceName: null,
        expiresAt: snapshot.expiresAt,
      },
    })
    expect(snapshot).toMatchObject({ revision: 1, state: "invited", hostRegion: "eu", partnerRegion: null })
  })

  test("should push the accepted snapshot to each side's own region when they differ", async () => {
    const host = await seedWorkspace("eu", "Acme")
    const partner = await seedWorkspace("us", "Globex")
    const { snapshot: invited, token } = await invite(host)

    const accepted = await service.accept({
      token,
      partnerWorkspaceId: partner,
      acceptedByUserId: "usr_partner_admin",
      visibility: "private",
    })
    await service.syncToRegions({ connectionId: accepted.id })

    expect(accepted).toEqual({
      ...invited,
      revision: 2,
      state: "active",
      partnerWorkspaceId: partner,
      partnerWorkspaceName: "Globex",
      partnerRegion: "us",
      partnerVisibility: "private",
    })
    expect({ eu: received(eu), us: received(us), events: await syncEvents(accepted.id) }).toEqual({
      eu: [{ url: "/internal/stream-connections", body: accepted }],
      us: [{ url: "/internal/stream-connections", body: accepted }],
      events: [{ connectionId: accepted.id }, { connectionId: accepted.id }],
    })
  })

  test("should still push to the healthy region and then fail when the other region is down", async () => {
    const host = await seedWorkspace("eu", "Acme")
    const partner = await seedWorkspace("us", "Globex")
    const { token } = await invite(host)
    const accepted = await service.accept({
      token,
      partnerWorkspaceId: partner,
      acceptedByUserId: "usr_partner_admin",
      visibility: "private",
    })
    us.setStreamConnectionStatus(503)

    const sync = service.syncToRegions({ connectionId: accepted.id })

    await expect(sync).rejects.toMatchObject({
      name: "AggregateError",
      message: "Stream connection sync failed (us: Regional backend returned 503: )",
    })
    expect({ eu: received(eu), us: received(us) }).toEqual({
      eu: [{ url: "/internal/stream-connections", body: accepted }],
      us: [{ url: "/internal/stream-connections", body: accepted }],
    })
  })

  test("should show a used link only to members of the workspace that accepted it", async () => {
    const host = await seedWorkspace("eu", "Acme")
    const partner = await seedWorkspace("us", "Globex")
    await WorkspaceRegistryRepository.insertMembership(pool, partner, "workos_partner_member")
    const { token } = await invite(host)
    await service.accept({ token, partnerWorkspaceId: partner, acceptedByUserId: "usr_p", visibility: "public" })

    const member = await service.lookup(token, "workos_partner_member")

    expect(member).toEqual(
      expect.objectContaining({ state: "active", partnerWorkspaceId: partner, partnerWorkspaceName: "Globex" })
    )
    await expect(service.lookup(token, "workos_outsider")).rejects.toMatchObject({
      status: 409,
      code: StreamConnectionErrorCodes.ALREADY_ACCEPTED,
    })
  })

  test("should push once when host and partner share a region", async () => {
    const host = await seedWorkspace("eu", "Acme")
    const partner = await seedWorkspace("eu", "Initech")
    const { token } = await invite(host)
    const accepted = await service.accept({
      token,
      partnerWorkspaceId: partner,
      acceptedByUserId: "usr_partner_admin",
      visibility: "public",
    })

    await service.syncToRegions({ connectionId: accepted.id })

    expect({ eu: received(eu), us: received(us) }).toEqual({
      eu: [{ url: "/internal/stream-connections", body: accepted }],
      us: [],
    })
  })

  test("should return the current state when the same partner accepts again", async () => {
    const host = await seedWorkspace("eu", "Acme")
    const partner = await seedWorkspace("us", "Globex")
    const { token } = await invite(host)
    const params = {
      token,
      partnerWorkspaceId: partner,
      acceptedByUserId: "usr_partner_admin",
      visibility: "public" as const,
    }

    const first = await service.accept(params)
    const retry = await service.accept(params)

    expect({ retry, events: await syncEvents(first.id) }).toEqual({
      retry: first,
      events: [{ connectionId: first.id }, { connectionId: first.id }],
    })
  })

  test("should let exactly one of two partners accept the same invite", async () => {
    const host = await seedWorkspace("eu", "Acme")
    const partners = [await seedWorkspace("us", "Globex"), await seedWorkspace("eu", "Initech")]
    const { token } = await invite(host)

    const results = await Promise.allSettled(
      partners.map((partnerWorkspaceId) =>
        service.accept({ token, partnerWorkspaceId, acceptedByUserId: "usr_partner_admin", visibility: "public" })
      )
    )

    const winners = results.filter((r) => r.status === "fulfilled")
    const losers = results.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason)
    expect(winners).toHaveLength(1)
    expect(losers).toMatchObject([{ status: 409, code: StreamConnectionErrorCodes.ALREADY_ACCEPTED }])
  })

  test("should revoke the pending invite when a new link is minted for the same channel", async () => {
    const host = await seedWorkspace("eu", "Acme")
    const first = await invite(host, "stream_relink")
    const second = await invite(host, "stream_relink")

    await expect(service.lookup(first.token, "workos_viewer")).rejects.toMatchObject({
      status: 409,
      code: StreamConnectionErrorCodes.REVOKED,
    })
    expect({
      superseded: second.superseded,
      lookup: (await service.lookup(second.token, "workos_viewer")).connectionId,
      firstEvents: await syncEvents(first.snapshot.id),
    }).toEqual({
      superseded: { ...first.snapshot, state: "revoked", revision: 2 },
      lookup: second.snapshot.id,
      firstEvents: [{ connectionId: first.snapshot.id }, { connectionId: first.snapshot.id }],
    })
    expect(first.superseded).toBeNull()
  })

  test("should refuse a new link for a channel that is already shared", async () => {
    const host = await seedWorkspace("eu", "Acme")
    const partner = await seedWorkspace("us", "Globex")
    const { token } = await invite(host, "stream_shared")
    await service.accept({ token, partnerWorkspaceId: partner, acceptedByUserId: "usr_p", visibility: "public" })

    await expect(invite(host, "stream_shared")).rejects.toMatchObject({
      status: 409,
      code: StreamConnectionErrorCodes.ALREADY_SHARED,
    })
  })

  test.each([
    ["no link is pending", false],
    ["a link is already pending", true],
  ])("should keep only the newest of three links minted at once when %s", async (_case, pending) => {
    const host = await seedWorkspace("eu", "Acme")
    const stream = `stream_race_${crypto.randomUUID()}`
    const earlier = pending ? await invite(host, stream) : null

    const minted = await Promise.all([invite(host, stream), invite(host, stream), invite(host, stream)])

    const live = await pool.query<{ id: string }>(
      `SELECT id FROM stream_connections WHERE host_workspace_id = $1 AND state IN ('invited', 'active')`,
      [host]
    )
    const liveIds = live.rows.map((r) => r.id)
    const mintedIds = minted.map((m) => m.snapshot.id)
    const everyId = earlier ? [earlier.snapshot.id, ...mintedIds] : mintedIds
    // Each mint superseded whatever was live when it ran, so every other link was superseded exactly once.
    expect({
      liveIsMinted: liveIds.length === 1 && mintedIds.includes(liveIds[0]),
      superseded: minted.flatMap((m) => (m.superseded ? [m.superseded.id] : [])).toSorted(),
    }).toEqual({
      liveIsMinted: true,
      superseded: everyId.filter((id) => id !== liveIds[0]).toSorted(),
    })
  })

  test("should refuse to accept an unknown, revoked, expired, or own-workspace invite", async () => {
    const host = await seedWorkspace("eu", "Acme")
    const partner = await seedWorkspace("us", "Globex")
    const accept = (token: string, partnerWorkspaceId = partner) =>
      service.accept({ token, partnerWorkspaceId, acceptedByUserId: "usr_p", visibility: "public" })

    const revokedInvite = await invite(host)
    await service.revokeInvite({ connectionId: revokedInvite.snapshot.id, hostWorkspaceId: host })
    const expiredInvite = await invite(host)
    await pool.query(`UPDATE stream_connections SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [
      expiredInvite.snapshot.id,
    ])
    const ownInvite = await invite(host)

    const outcomes = await Promise.allSettled([
      accept("not-a-token"),
      accept(revokedInvite.token),
      accept(expiredInvite.token),
      accept(ownInvite.token, host),
    ])

    expect(outcomes.map((o) => (o.status === "rejected" ? (o.reason as { code: string }).code : "accepted"))).toEqual([
      StreamConnectionErrorCodes.NOT_FOUND,
      StreamConnectionErrorCodes.REVOKED,
      StreamConnectionErrorCodes.EXPIRED,
      StreamConnectionErrorCodes.SAME_WORKSPACE,
    ])
    await expect(service.lookup(expiredInvite.token, "workos_viewer")).rejects.toMatchObject({
      code: StreamConnectionErrorCodes.EXPIRED,
    })
  })

  test("should revoke a pending invite once, and refuse another workspace or an accepted share", async () => {
    const host = await seedWorkspace("eu", "Acme")
    const partner = await seedWorkspace("us", "Globex")
    const pending = await invite(host)

    const revoked = await service.revokeInvite({ connectionId: pending.snapshot.id, hostWorkspaceId: host })
    const again = await service.revokeInvite({ connectionId: pending.snapshot.id, hostWorkspaceId: host })

    expect({ revoked, again, events: await syncEvents(pending.snapshot.id) }).toEqual({
      revoked: { ...pending.snapshot, state: "revoked", revision: 2 },
      again: { ...pending.snapshot, state: "revoked", revision: 2 },
      events: [{ connectionId: pending.snapshot.id }, { connectionId: pending.snapshot.id }],
    })
    await expect(
      service.revokeInvite({ connectionId: pending.snapshot.id, hostWorkspaceId: partner })
    ).rejects.toMatchObject({ status: 404, code: StreamConnectionErrorCodes.NOT_FOUND })

    const shared = await invite(host)
    await service.accept({
      token: shared.token,
      partnerWorkspaceId: partner,
      acceptedByUserId: "usr_p",
      visibility: "public",
    })
    await expect(
      service.revokeInvite({ connectionId: shared.snapshot.id, hostWorkspaceId: host })
    ).rejects.toMatchObject({ status: 409, code: StreamConnectionErrorCodes.ALREADY_ACCEPTED })
  })
})
