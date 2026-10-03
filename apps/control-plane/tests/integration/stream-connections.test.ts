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
      invitedBy: "usr_inviter",
    })
  }

  function accept(token: string, partnerWorkspaceId: string, visibility: "public" | "private" = "public") {
    return service.accept({ token, partnerWorkspaceId, visibility, acceptedBy: `usr_admin_of_${partnerWorkspaceId}` })
  }

  async function syncEvents(connectionId: string): Promise<StreamConnectionSyncPayload[]> {
    const result = await pool.query<{ payload: StreamConnectionSyncPayload }>(
      `SELECT payload FROM outbox WHERE event_type = $1 AND payload->>'connectionId' = $2 ORDER BY id`,
      [OUTBOX_STREAM_CONNECTION_SYNC, connectionId]
    )
    return result.rows.map((r) => r.payload)
  }

  async function liveConnections(hostWorkspaceId: string): Promise<{ id: string; state: string }[]> {
    const result = await pool.query<{ id: string; state: string }>(
      `SELECT id, state FROM stream_connections WHERE host_workspace_id = $1 AND state IN ('invited', 'active')`,
      [hostWorkspaceId]
    )
    return result.rows
  }

  function outcomeOf(result: PromiseSettledResult<unknown>, success: string): string {
    return result.status === "fulfilled" ? success : (result.reason as { code: string }).code
  }

  function received(region: MockRegionalBackend) {
    return region.requests.filter((r) => r.method === "POST").map((r) => ({ url: r.url, body: r.body }))
  }

  function shareableChecks(region: MockRegionalBackend) {
    return region.requests.filter((r) => r.method === "GET").map((r) => r.url)
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
        state: "invited",
        hostWorkspaceId: host,
        hostWorkspaceName: "Acme",
        hostRegion: "eu",
        streamDisplayName: "Launch",
        streamSlug: "launch",
        partnerWorkspaceId: null,
        partnerWorkspaceName: null,
        partners: [],
      },
    })
    expect(snapshot).toMatchObject({
      revision: 1,
      state: "invited",
      hostRegion: "eu",
      partnerRegion: null,
      invitedBy: "usr_inviter",
      acceptedBy: null,
      peerWorkspaceIds: [],
    })
  })

  test("should push the accepted snapshot to each side's own region when they differ", async () => {
    const host = await seedWorkspace("eu", "Acme")
    const partner = await seedWorkspace("us", "Globex")
    const { snapshot: invited, token } = await invite(host)

    const accepted = await accept(token, partner, "private")
    await service.syncToRegions({ connectionId: accepted.id })

    expect(accepted).toEqual({
      ...invited,
      revision: 2,
      state: "active",
      partnerWorkspaceId: partner,
      partnerWorkspaceName: "Globex",
      partnerRegion: "us",
      partnerVisibility: "private",
      acceptedBy: `usr_admin_of_${partner}`,
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
    const accepted = await accept(token, partner, "private")
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
    await accept(token, partner)

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
    const accepted = await accept(token, partner)

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

    const first = await accept(token, partner)
    const retry = await accept(token, partner)

    expect({ retry, events: await syncEvents(first.id) }).toEqual({
      retry: first,
      events: [{ connectionId: first.id }, { connectionId: first.id }],
    })
  })

  test("should let exactly one of two partners accept the same invite", async () => {
    const host = await seedWorkspace("eu", "Acme")
    const partners = [await seedWorkspace("us", "Globex"), await seedWorkspace("eu", "Initech")]
    const { token } = await invite(host)

    const results = await Promise.allSettled(partners.map((partner) => accept(token, partner)))

    const winners = results.filter((r) => r.status === "fulfilled")
    const losers = results.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason)
    expect(winners).toHaveLength(1)
    expect(losers).toMatchObject([{ status: 409, code: StreamConnectionErrorCodes.ALREADY_ACCEPTED }])
  })

  test("should let a third workspace join and push every connection to the region of every workspace in it", async () => {
    const host = await seedWorkspace("eu", "Acme")
    const second = await seedWorkspace("us", "Globex")
    const third = await seedWorkspace("eu", "Initech")
    const stream = `stream_trio_${crypto.randomUUID()}`
    const first = await invite(host, stream)
    const secondConnection = await accept(first.token, second)
    const next = await invite(host, stream)
    eu.reset()
    us.reset()

    const thirdConnection = await accept(next.token, third)
    const resynced = await service.listForWorkspace({ workspaceId: host, streamId: stream, includeIds: [] })
    await service.syncToRegions({ connectionId: thirdConnection.id })
    await service.syncToRegions({ connectionId: secondConnection.id })

    const secondNow = { ...secondConnection, peerWorkspaceIds: [third] }
    expect({
      thirdConnection,
      resynced,
      eu: received(eu),
      us: received(us),
      secondEvents: await syncEvents(secondConnection.id),
    }).toEqual({
      thirdConnection: {
        ...next.snapshot,
        revision: 2,
        state: "active",
        partnerWorkspaceId: third,
        partnerWorkspaceName: "Initech",
        partnerRegion: "eu",
        partnerVisibility: "public",
        acceptedBy: `usr_admin_of_${third}`,
        peerWorkspaceIds: [second],
      },
      resynced: [secondNow, thirdConnection],
      eu: [
        { url: "/internal/stream-connections", body: thirdConnection },
        { url: "/internal/stream-connections", body: secondNow },
      ],
      us: [
        { url: "/internal/stream-connections", body: thirdConnection },
        { url: "/internal/stream-connections", body: secondNow },
      ],
      // Minted, accepted, then synced again when the third workspace joined.
      secondEvents: [
        { connectionId: secondConnection.id },
        { connectionId: secondConnection.id },
        { connectionId: secondConnection.id },
      ],
    })
  })

  test("should name the workspaces already in the channel on a new link's invite page", async () => {
    const host = await seedWorkspace("eu", "Acme")
    const partners = [await seedWorkspace("us", "Globex"), await seedWorkspace("eu", "Initech")]
    const stream = `stream_named_${crypto.randomUUID()}`
    for (const partner of partners) {
      await accept((await invite(host, stream)).token, partner)
    }
    const { token } = await invite(host, stream)

    expect(await service.lookup(token, "workos_viewer")).toMatchObject({
      state: "invited",
      partners: [
        { workspaceId: partners[0], workspaceName: "Globex" },
        { workspaceId: partners[1], workspaceName: "Initech" },
      ],
    })
  })

  test("should refuse a workspace already in the channel and leave the second link pending", async () => {
    const host = await seedWorkspace("eu", "Acme")
    const partner = await seedWorkspace("us", "Globex")
    const stream = `stream_twice_${crypto.randomUUID()}`
    await accept((await invite(host, stream)).token, partner)
    const second = await invite(host, stream)

    await expect(accept(second.token, partner)).rejects.toMatchObject({
      status: 409,
      code: StreamConnectionErrorCodes.ALREADY_CONNECTED,
    })
    expect({
      lookup: (await service.lookup(second.token, "workos_viewer")).state,
      events: await syncEvents(second.snapshot.id),
    }).toEqual({ lookup: "invited", events: [{ connectionId: second.snapshot.id }] })
  })

  test("should let one workspace in when it accepts two links to the same channel at once", async () => {
    const host = await seedWorkspace("eu", "Acme")
    const partner = await seedWorkspace("us", "Globex")
    const stream = `stream_double_${crypto.randomUUID()}`
    const links = [await invite(host, stream), await invite(host, stream)]

    const results = await Promise.allSettled(links.map((link) => accept(link.token, partner)))

    expect({
      outcomes: results.map((r) => outcomeOf(r, "accepted")).toSorted(),
      live: (await liveConnections(host)).map((c) => c.state).toSorted(),
    }).toEqual({
      outcomes: [StreamConnectionErrorCodes.ALREADY_CONNECTED, "accepted"],
      live: ["active", "invited"],
    })
  })

  test("should let two workspaces accept links to one channel at once and sync each to the other", async () => {
    const host = await seedWorkspace("eu", "Acme")
    const partners = [await seedWorkspace("us", "Globex"), await seedWorkspace("eu", "Initech")]
    const stream = `stream_pair_${crypto.randomUUID()}`
    const links = [await invite(host, stream), await invite(host, stream)]

    const accepted = await Promise.all(links.map((link, i) => accept(link.token, partners[i])))

    const events = await Promise.all(accepted.map((c) => syncEvents(c.id)))
    const listed = await service.listForWorkspace({ workspaceId: partners[0], streamId: stream, includeIds: [] })
    expect({
      peers: listed.map((c) => ({ id: c.id, partner: c.partnerWorkspaceId, peers: c.peerWorkspaceIds })),
      // Accepts take turns, so whichever went second synced the first again for its new peer.
      eventCounts: events.map((e) => e.length).toSorted(),
    }).toEqual({
      peers: expect.arrayContaining([
        { id: accepted[0].id, partner: partners[0], peers: [partners[1]] },
        { id: accepted[1].id, partner: partners[1], peers: [partners[0]] },
      ]),
      eventCounts: [2, 3],
    })
  })

  test("should keep every link pending when several are minted for one channel at once", async () => {
    const host = await seedWorkspace("eu", "Acme")
    const stream = `stream_many_${crypto.randomUUID()}`

    const minted = await Promise.all([invite(host, stream), invite(host, stream), invite(host, stream)])

    expect((await liveConnections(host)).toSorted((a, b) => a.id.localeCompare(b.id))).toEqual(
      minted.map((m) => ({ id: m.snapshot.id, state: "invited" })).toSorted((a, b) => a.id.localeCompare(b.id))
    )
  })

  test("should refuse to revoke an accepted share without touching it", async () => {
    const host = await seedWorkspace("eu", "Acme")
    const partner = await seedWorkspace("us", "Globex")
    const { snapshot, token } = await invite(host)
    await accept(token, partner)

    await expect(service.revokeInvite({ connectionId: snapshot.id, hostWorkspaceId: host })).rejects.toMatchObject({
      status: 409,
      code: StreamConnectionErrorCodes.ALREADY_ACCEPTED,
    })
    expect({
      live: await liveConnections(host),
      events: await syncEvents(snapshot.id),
    }).toEqual({
      live: [{ id: snapshot.id, state: "active" }],
      events: [{ connectionId: snapshot.id }, { connectionId: snapshot.id }],
    })
  })

  test("should either share the channel or revoke the invite when a revoke races the accept", async () => {
    const host = await seedWorkspace("eu", "Acme")
    const partner = await seedWorkspace("us", "Globex")
    const { snapshot, token } = await invite(host)

    const [accepted, revoked] = await Promise.allSettled([
      accept(token, partner),
      service.revokeInvite({ connectionId: snapshot.id, hostWorkspaceId: host }),
    ])

    expect([
      {
        accept: "accepted",
        revoke: StreamConnectionErrorCodes.ALREADY_ACCEPTED,
        live: [{ id: snapshot.id, state: "active" }],
      },
      { accept: StreamConnectionErrorCodes.REVOKED, revoke: "revoked", live: [] },
    ]).toContainEqual({
      accept: outcomeOf(accepted, "accepted"),
      revoke: outcomeOf(revoked, "revoked"),
      live: await liveConnections(host),
    })
  })

  test("should ask the host region before accepting and refuse when the channel is no longer shareable", async () => {
    const host = await seedWorkspace("eu", "Acme")
    const partner = await seedWorkspace("us", "Globex")
    const { snapshot, token } = await invite(host)
    eu.setStreamShareable(false)

    await expect(accept(token, partner)).rejects.toMatchObject({
      status: 409,
      code: StreamConnectionErrorCodes.NOT_SHAREABLE,
    })

    const query = new URLSearchParams({ workspaceId: host, streamId: snapshot.hostStreamId })
    expect({
      eu: shareableChecks(eu),
      us: shareableChecks(us),
      live: await liveConnections(host),
      events: await syncEvents(snapshot.id),
    }).toEqual({
      eu: [`/internal/stream-connections/shareable?${query}`],
      us: [],
      live: [{ id: snapshot.id, state: "invited" }],
      events: [{ connectionId: snapshot.id }],
    })
  })

  test("should leave the invite pending when the host region can't answer the shareable check", async () => {
    const host = await seedWorkspace("eu", "Acme")
    const partner = await seedWorkspace("us", "Globex")
    const { snapshot, token } = await invite(host)
    eu.setStreamShareable("error")

    await expect(accept(token, partner)).rejects.toThrow("Regional backend returned 503")

    expect({
      live: await liveConnections(host),
      events: await syncEvents(snapshot.id),
    }).toEqual({
      live: [{ id: snapshot.id, state: "invited" }],
      events: [{ connectionId: snapshot.id }],
    })
  })

  test("should not ask the host region again when the partner retries an accepted invite", async () => {
    const host = await seedWorkspace("eu", "Acme")
    const partner = await seedWorkspace("us", "Globex")
    const { snapshot, token } = await invite(host)
    await accept(token, partner)
    eu.reset()
    eu.setStreamShareable("error")

    const retried = await accept(token, partner)

    expect({ state: retried.state, checks: shareableChecks(eu), events: await syncEvents(snapshot.id) }).toEqual({
      state: "active",
      checks: [],
      events: [{ connectionId: snapshot.id }, { connectionId: snapshot.id }],
    })
  })

  test("should refuse to accept an unknown, revoked, expired, or own-workspace invite", async () => {
    const host = await seedWorkspace("eu", "Acme")
    const partner = await seedWorkspace("us", "Globex")
    const revokedInvite = await invite(host)
    await service.revokeInvite({ connectionId: revokedInvite.snapshot.id, hostWorkspaceId: host })
    const expiredInvite = await invite(host)
    await pool.query(`UPDATE stream_connections SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [
      expiredInvite.snapshot.id,
    ])
    const ownInvite = await invite(host)
    // Each refusal is about the invite itself, so it wins over the channel no longer being shareable.
    eu.setStreamShareable(false)

    const outcomes = await Promise.allSettled([
      accept("not-a-token", partner),
      accept(revokedInvite.token, partner),
      accept(expiredInvite.token, partner),
      accept(ownInvite.token, host),
    ])

    expect({
      outcomes: outcomes.map((o) => (o.status === "rejected" ? (o.reason as { code: string }).code : "accepted")),
      checks: shareableChecks(eu),
    }).toEqual({
      outcomes: [
        StreamConnectionErrorCodes.NOT_FOUND,
        StreamConnectionErrorCodes.REVOKED,
        StreamConnectionErrorCodes.EXPIRED,
        StreamConnectionErrorCodes.SAME_WORKSPACE,
      ],
      checks: [],
    })
    await expect(service.lookup(expiredInvite.token, "workos_viewer")).rejects.toMatchObject({
      code: StreamConnectionErrorCodes.EXPIRED,
    })
  })

  test("should list a channel's connections to the workspaces that hold them, and settled ones only on request", async () => {
    const host = await seedWorkspace("eu", "Acme")
    const second = await seedWorkspace("us", "Globex")
    const third = await seedWorkspace("eu", "Initech")
    const stranger = await seedWorkspace("us", "Hooli")
    const stream = `stream_listed_${crypto.randomUUID()}`
    const secondConnection = await accept((await invite(host, stream)).token, second)
    const thirdConnection = await accept((await invite(host, stream)).token, third)
    const pending = await invite(host, stream)
    const revoked = await invite(host, stream)
    await service.revokeInvite({ connectionId: revoked.snapshot.id, hostWorkspaceId: host })
    const expiredInvite = await invite(host, stream)
    await pool.query(`UPDATE stream_connections SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [
      expiredInvite.snapshot.id,
    ])
    await invite(host, `stream_other_${crypto.randomUUID()}`)

    const list = async (workspaceId: string, includeIds: string[] = []) =>
      (await service.listForWorkspace({ workspaceId, streamId: stream, includeIds })).map((c) => [c.id, c.state])

    expect({
      host: await list(host),
      hostAskingAfterSettled: await list(host, [revoked.snapshot.id, expiredInvite.snapshot.id]),
      second: await list(second),
      third: await list(third, [pending.snapshot.id]),
      stranger: await list(stranger, [secondConnection.id, pending.snapshot.id]),
    }).toEqual({
      host: [
        [secondConnection.id, "active"],
        [thirdConnection.id, "active"],
        [pending.snapshot.id, "invited"],
      ],
      hostAskingAfterSettled: [
        [secondConnection.id, "active"],
        [thirdConnection.id, "active"],
        [pending.snapshot.id, "invited"],
        [revoked.snapshot.id, "revoked"],
        [expiredInvite.snapshot.id, "invited"],
      ],
      // A partner sees the channel's other partners, never the host's pending links.
      second: [
        [secondConnection.id, "active"],
        [thirdConnection.id, "active"],
      ],
      third: [
        [secondConnection.id, "active"],
        [thirdConnection.id, "active"],
      ],
      stranger: [],
    })
  })

  test("should revoke a pending invite once, and refuse another workspace", async () => {
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
  })
})
