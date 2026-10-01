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

  async function syncEvents(connectionId: string): Promise<number> {
    const result = await pool.query(`SELECT 1 FROM outbox WHERE event_type = $1 AND payload->>'connectionId' = $2`, [
      OUTBOX_STREAM_CONNECTION_SYNC,
      connectionId,
    ])
    return result.rowCount ?? 0
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

    expect({ eu: received(eu), us: received(us), lookup: await service.lookup(token) }).toEqual({
      eu: [{ url: "/internal/stream-connections", body: snapshot }],
      us: [],
      lookup: {
        connectionId: snapshot.id,
        state: "invited",
        hostWorkspaceId: host,
        hostWorkspaceName: "Acme",
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
      acceptedByUserId: "usr_partner_admin",
    })
    expect({ eu: received(eu), us: received(us) }).toEqual({
      eu: [{ url: "/internal/stream-connections", body: accepted }],
      us: [{ url: "/internal/stream-connections", body: accepted }],
    })
    expect(await syncEvents(accepted.id)).toBe(2)
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

    expect({ retry, events: await syncEvents(first.id) }).toEqual({ retry: first, events: 2 })
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

    await expect(service.lookup(first.token)).rejects.toMatchObject({
      status: 409,
      code: StreamConnectionErrorCodes.REVOKED,
    })
    expect({
      superseded: second.superseded,
      lookup: (await service.lookup(second.token)).connectionId,
      firstEvents: await syncEvents(first.snapshot.id),
    }).toEqual({
      superseded: { ...first.snapshot, state: "revoked", revision: 2 },
      lookup: second.snapshot.id,
      firstEvents: 2,
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

  test("should keep one live connection when two links are minted for a channel at once", async () => {
    const host = await seedWorkspace("eu", "Acme")

    const results = await Promise.allSettled([invite(host, "stream_race"), invite(host, "stream_race")])

    const live = await pool.query(
      `SELECT id FROM stream_connections WHERE host_workspace_id = $1 AND state IN ('invited', 'active')`,
      [host]
    )
    expect(live.rowCount).toBe(1)
    for (const r of results) {
      if (r.status === "rejected") {
        expect(r.reason).toMatchObject({ status: 409, code: StreamConnectionErrorCodes.ALREADY_SHARED })
      }
    }
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
    await expect(service.lookup(expiredInvite.token)).rejects.toMatchObject({
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
      events: 2,
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
