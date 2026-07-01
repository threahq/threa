import { afterEach, describe, expect, it, vi } from "vitest"
import type { StreamEvent } from "@threa/types"
import { ThreaDatabase, accountDbName, db } from "@/db"
import { parsePersistedSyncTarget, runBootstrapSync } from "./sw-bootstrap-prefetch"

// The SW has no AccountScope, so the prefetch must open the per-account
// database (accountDbName) explicitly — writing through the default `db` proxy
// lands in the pre-auth "threa" database the signed-in app never reads. These
// tests are the regression guard for that account routing.

function makeEvent(overrides: Partial<StreamEvent> & { id: string; streamId: string; sequence: string }): StreamEvent {
  return {
    eventType: "message_created",
    payload: { messageId: overrides.id, contentMarkdown: "hello" },
    actorId: "user_1",
    actorType: "user",
    createdAt: new Date().toISOString(),
    ...overrides,
  } as StreamEvent
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

/**
 * Mock fetch per-path. The workspace bootstrap URL answers 404 so
 * prefetchWorkspaceBootstrap returns before touching the Cache API (jsdom has
 * no CacheStorage); its cache-write path is unchanged by this refactor.
 */
function mockFetch(routes: Record<string, unknown>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    for (const [fragment, data] of Object.entries(routes)) {
      if (url.includes(fragment)) return jsonResponse(data)
    }
    return new Response(null, { status: 404 })
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("runBootstrapSync account routing", () => {
  it("writes stream bootstrap events into the account's database, not the default one", async () => {
    const workosUserId = "user_acct_route"
    const streamId = "stream_route1"
    mockFetch({
      [`/streams/${streamId}/bootstrap`]: {
        stream: { id: streamId, workspaceId: "ws_1", type: "channel", slug: "general" },
        events: [
          makeEvent({ id: "evt_1", streamId, sequence: "1" }),
          makeEvent({ id: "evt_2", streamId, sequence: "2" }),
        ],
      },
    })

    await runBootstrapSync({ workspaceId: "ws_1", streamId, messageId: null, workosUserId })

    const accountDb = new ThreaDatabase(accountDbName(workosUserId))
    const accountEvents = await accountDb.events.where("streamId").equals(streamId).toArray()
    expect(accountEvents.map((e) => e.id).sort()).toEqual(["evt_1", "evt_2"])
    expect(accountEvents[0].workspaceId).toBe("ws_1")
    expect(accountEvents[0]._sequenceNum).toBe(1)

    // The default (pre-auth) database the signed-in app never reads must stay
    // untouched — writing there is exactly the bug this guards against.
    const defaultEvents = await db.events.where("streamId").equals(streamId).toArray()
    expect(defaultEvents).toEqual([])
  })

  it("writes events-around results for the pushed message into the account's database", async () => {
    const workosUserId = "user_acct_around"
    const streamId = "stream_around1"
    mockFetch({
      [`/streams/${streamId}/bootstrap`]: {
        stream: { id: streamId, workspaceId: "ws_1", type: "channel", slug: "general" },
        events: [makeEvent({ id: "evt_old", streamId, sequence: "1" })],
      },
      "/events/around": {
        events: [makeEvent({ id: "evt_pushed", streamId, sequence: "9" })],
      },
    })

    await runBootstrapSync({ workspaceId: "ws_1", streamId, messageId: "evt_pushed", workosUserId })

    const accountDb = new ThreaDatabase(accountDbName(workosUserId))
    const events = await accountDb.events.where("streamId").equals(streamId).toArray()
    expect(events.map((e) => e.id).sort()).toEqual(["evt_old", "evt_pushed"])
  })

  it("merges onto an existing stream row instead of clobbering it", async () => {
    const workosUserId = "user_acct_merge"
    const streamId = "stream_merge1"
    const accountDb = new ThreaDatabase(accountDbName(workosUserId))
    await accountDb.streams.put({
      id: streamId,
      workspaceId: "ws_1",
      type: "channel",
      slug: "general",
      notificationLevel: "mentions",
      _cachedAt: 1,
    } as never)

    mockFetch({
      [`/streams/${streamId}/bootstrap`]: {
        stream: { id: streamId, workspaceId: "ws_1", type: "channel", slug: "general" },
        events: [makeEvent({ id: "evt_m1", streamId, sequence: "3" })],
      },
    })

    await runBootstrapSync({ workspaceId: "ws_1", streamId, messageId: null, workosUserId })

    const row = (await accountDb.streams.get(streamId)) as { notificationLevel?: string; lastMessagePreview?: unknown }
    expect(row.notificationLevel).toBe("mentions")
    expect(row.lastMessagePreview).toMatchObject({ authorId: "user_1" })
  })

  it("skips all IndexedDB writes when the target carries no account id", async () => {
    const streamId = "stream_noacct1"
    const fetchMock = mockFetch({
      [`/streams/${streamId}/bootstrap`]: {
        stream: { id: streamId, workspaceId: "ws_1", type: "channel", slug: "general" },
        events: [makeEvent({ id: "evt_n1", streamId, sequence: "1" })],
      },
    })

    await runBootstrapSync({ workspaceId: "ws_1", streamId, messageId: "evt_n1", workosUserId: null })

    const defaultEvents = await db.events.where("streamId").equals(streamId).toArray()
    expect(defaultEvents).toEqual([])
    // The stream endpoints are never even fetched; only the (account-agnostic)
    // workspace bootstrap warm-up runs.
    const fetchedUrls = fetchMock.mock.calls.map((c) => String(c[0]))
    expect(fetchedUrls).toEqual(["/api/workspaces/ws_1/bootstrap"])
  })
})

describe("parsePersistedSyncTarget", () => {
  it("normalizes a legacy target persisted without workosUserId", () => {
    expect(parsePersistedSyncTarget({ workspaceId: "ws_1", streamId: "stream_1", messageId: null })).toEqual({
      workspaceId: "ws_1",
      streamId: "stream_1",
      messageId: null,
      workosUserId: null,
    })
  })

  it("rejects entries with no workspace id", () => {
    expect(parsePersistedSyncTarget({ streamId: "stream_1" })).toBeNull()
    expect(parsePersistedSyncTarget(null)).toBeNull()
    expect(parsePersistedSyncTarget("junk")).toBeNull()
  })
})
