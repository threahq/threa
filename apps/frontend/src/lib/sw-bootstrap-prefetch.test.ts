import { afterEach, describe, expect, it, vi } from "vitest"
import { sharedMessageSlotKey, type StreamEvent } from "@threa/types"
import { ThreaDatabase, accountDbName, db } from "@/db"
import { parsePersistedSyncTarget, respondToBootstrapRequest, runBootstrapSync } from "./sw-bootstrap-prefetch"

const missingSlot = (messageId: string) => ({ type: "sharedMessage", state: "missing", messageId }) as const

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

  it("persists the bootstrap's canonical slot carrier into the account database", async () => {
    const workosUserId = "user_acct_slots"
    const streamId = "stream_slots1"
    mockFetch({
      [`/streams/${streamId}/bootstrap`]: {
        stream: { id: streamId, workspaceId: "ws_1", type: "channel", slug: "general" },
        events: [makeEvent({ id: "evt_s1", streamId, sequence: "1" })],
        slots: { [sharedMessageSlotKey("msg_src")]: missingSlot("msg_src") },
      },
    })

    await runBootstrapSync({ workspaceId: "ws_1", streamId, messageId: null, workosUserId })

    const accountDb = new ThreaDatabase(accountDbName(workosUserId))
    const rows = await accountDb.slots.where("streamId").equals(streamId).toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ slotKey: sharedMessageSlotKey("msg_src"), value: missingSlot("msg_src") })
  })

  it("rekeys a legacy-only bootstrap carrier and merges events-around slots", async () => {
    const workosUserId = "user_acct_slots_legacy"
    const streamId = "stream_slots2"
    mockFetch({
      [`/streams/${streamId}/bootstrap`]: {
        stream: { id: streamId, workspaceId: "ws_1", type: "channel", slug: "general" },
        events: [makeEvent({ id: "evt_old", streamId, sequence: "1" })],
        sharedMessages: { msg_bootstrap: missingSlot("msg_bootstrap") },
      },
      "/events/around": {
        events: [makeEvent({ id: "evt_pushed", streamId, sequence: "9" })],
        slots: { [sharedMessageSlotKey("msg_around")]: missingSlot("msg_around") },
      },
    })

    await runBootstrapSync({ workspaceId: "ws_1", streamId, messageId: "evt_pushed", workosUserId })

    const accountDb = new ThreaDatabase(accountDbName(workosUserId))
    const rows = await accountDb.slots.where("streamId").equals(streamId).toArray()
    const byKey = Object.fromEntries(rows.map((r) => [r.slotKey, r.value]))
    expect(byKey).toEqual({
      [sharedMessageSlotKey("msg_bootstrap")]: missingSlot("msg_bootstrap"),
      [sharedMessageSlotKey("msg_around")]: missingSlot("msg_around"),
    })
  })

  it("replace prefetch keeps slot keys merged from out-of-window pages (B2)", async () => {
    const workosUserId = "user_acct_slots_window"
    const streamId = "stream_slots3"
    const accountDb = new ThreaDatabase(accountDbName(workosUserId))
    // A live scrolled-up session already merged this key from an older page;
    // the prefetch's replace window doesn't reference it, so it must survive.
    await accountDb.slots.put({
      workspaceId: "ws_1",
      streamId,
      slotKey: sharedMessageSlotKey("msg_page"),
      value: missingSlot("msg_page"),
      _cachedAt: 1,
    })

    mockFetch({
      [`/streams/${streamId}/bootstrap`]: {
        stream: { id: streamId, workspaceId: "ws_1", type: "channel", slug: "general" },
        events: [
          makeEvent({
            id: "evt_s3",
            streamId,
            sequence: "1",
            payload: {
              messageId: "evt_s3",
              contentJson: {
                type: "doc",
                content: [{ type: "sharedMessage", attrs: { messageId: "msg_window", streamId: "stream_src" } }],
              },
            },
          }),
        ],
        slots: { [sharedMessageSlotKey("msg_window")]: missingSlot("msg_window") },
      },
    })

    await runBootstrapSync({ workspaceId: "ws_1", streamId, messageId: null, workosUserId })

    const rows = await accountDb.slots.where("streamId").equals(streamId).toArray()
    expect(Object.fromEntries(rows.map((r) => [r.slotKey, r.value]))).toEqual({
      [sharedMessageSlotKey("msg_window")]: missingSlot("msg_window"),
      [sharedMessageSlotKey("msg_page")]: missingSlot("msg_page"),
    })
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

  it("rejects entries whose optional fields are not strings", () => {
    expect(parsePersistedSyncTarget({ workspaceId: "ws_1", streamId: 42 })).toBeNull()
    expect(parsePersistedSyncTarget({ workspaceId: "ws_1", messageId: {} })).toBeNull()
    expect(parsePersistedSyncTarget({ workspaceId: "ws_1", workosUserId: ["user_1"] })).toBeNull()
  })
})

describe("respondToBootstrapRequest", () => {
  const URL_ = "https://app.threa.io/api/workspaces/ws_1/bootstrap"

  /** Minimal Cache stand-in — jsdom has no CacheStorage. */
  function fakeCache(seed?: Response) {
    const store = new Map<string, Response>()
    if (seed) store.set(URL_, seed)
    return {
      store,
      match: vi.fn(async (key: string) => store.get(key)),
      delete: vi.fn(async (key: string) => store.delete(key)),
    } as unknown as Cache & { store: Map<string, Response> }
  }

  it("serves the pre-fetched copy once, then drops it", async () => {
    const cache = fakeCache(new Response("cached"))
    const fetchImpl = vi.fn(async () => new Response("network"))

    const res = await respondToBootstrapRequest(new Request(URL_), cache, fetchImpl)

    expect(await res.text()).toBe("cached")
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(cache.delete).toHaveBeenCalledWith(URL_)
  })

  it("goes to the network when nothing is pre-fetched", async () => {
    const cache = fakeCache()
    const fetchImpl = vi.fn(async () => new Response("network"))

    expect(await (await respondToBootstrapRequest(new Request(URL_), cache, fetchImpl)).text()).toBe("network")
    expect(fetchImpl).toHaveBeenCalled()
  })

  it("refuses the pre-fetched copy for a no-store request and discards it", async () => {
    // The caller is about to stamp a sync cursor against this snapshot, so a
    // copy captured when the tab last hid would strand every entry since. It
    // must also be deleted, not merely skipped — otherwise the next request
    // with the same expectation is handed the same stale copy.
    const cache = fakeCache(new Response("cached"))
    const fetchImpl = vi.fn(async () => new Response("network"))

    const res = await respondToBootstrapRequest(new Request(URL_, { cache: "no-store" }), cache, fetchImpl)

    expect(await res.text()).toBe("network")
    expect(cache.store.has(URL_)).toBe(false)
  })
})
