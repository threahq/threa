import { afterEach, describe, expect, it, vi } from "vitest"
import { ACCOUNT_ASSERTION_HEADER, sharedMessageSlotKey, type StreamEvent } from "@threahq/types"
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
function mockFetch(routes: Record<string, unknown>, authAs?: string | null): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    // The worker fetches with the browser's active session cookie, so every
    // prefetch first asks who that is. Tests declare it explicitly.
    if (url.includes("/api/auth/me")) {
      return authAs
        ? new Response(JSON.stringify({ id: authAs }), { status: 200, headers: { "Content-Type": "application/json" } })
        : new Response(null, { status: 401 })
    }
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
    mockFetch(
      {
        [`/streams/${streamId}/bootstrap`]: {
          stream: { id: streamId, workspaceId: "ws_1", type: "channel", slug: "general" },
          events: [
            makeEvent({ id: "evt_1", streamId, sequence: "1" }),
            makeEvent({ id: "evt_2", streamId, sequence: "2" }),
          ],
        },
      },
      workosUserId
    )

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
    mockFetch(
      {
        [`/streams/${streamId}/bootstrap`]: {
          stream: { id: streamId, workspaceId: "ws_1", type: "channel", slug: "general" },
          events: [makeEvent({ id: "evt_old", streamId, sequence: "1" })],
        },
        "/events/around": {
          events: [makeEvent({ id: "evt_pushed", streamId, sequence: "9" })],
        },
      },
      workosUserId
    )

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

    mockFetch(
      {
        [`/streams/${streamId}/bootstrap`]: {
          stream: { id: streamId, workspaceId: "ws_1", type: "channel", slug: "general" },
          events: [makeEvent({ id: "evt_m1", streamId, sequence: "3" })],
        },
      },
      workosUserId
    )

    await runBootstrapSync({ workspaceId: "ws_1", streamId, messageId: null, workosUserId })

    const row = (await accountDb.streams.get(streamId)) as { notificationLevel?: string; lastMessagePreview?: unknown }
    expect(row.notificationLevel).toBe("mentions")
    expect(row.lastMessagePreview).toMatchObject({ authorId: "user_1" })
  })

  it("derives the preview from markdown even when the event carries contentJson", async () => {
    const workosUserId = "user_acct_preview"
    const streamId = "stream_preview1"
    const accountDb = new ThreaDatabase(accountDbName(workosUserId))

    mockFetch(
      {
        [`/streams/${streamId}/bootstrap`]: {
          stream: { id: streamId, workspaceId: "ws_1", type: "channel", slug: "general" },
          events: [
            makeEvent({
              id: "evt_p1",
              streamId,
              sequence: "3",
              payload: {
                messageId: "evt_p1",
                contentMarkdown: "hello there",
                contentJson: {
                  type: "doc",
                  content: [{ type: "paragraph", content: [{ type: "text", text: "hello there" }] }],
                },
              },
            } as never),
          ],
        },
      },
      workosUserId
    )

    await runBootstrapSync({ workspaceId: "ws_1", streamId, messageId: null, workosUserId })

    const preview = (await accountDb.streams.get(streamId))?.lastMessagePreview
    expect({ type: typeof preview?.content, content: preview?.content }).toEqual({
      type: "string",
      content: "hello there",
    })
  })

  it("prefetches nothing when the browser is signed in as a different account", async () => {
    // The worker fetches with whatever session cookie the browser holds. If the
    // viewer has since switched, that response is the *active* account's view of
    // the workspace — writing it into the push recipient's database would hand
    // one account the other's messages.
    const workosUserId = "user_push_recipient"
    const streamId = "stream_wrong_cred"
    const fetchMock = mockFetch(
      {
        [`/streams/${streamId}/bootstrap`]: {
          stream: { id: streamId, workspaceId: "ws_1", type: "channel", slug: "general" },
          events: [makeEvent({ id: "evt_leak", streamId, sequence: "1" })],
        },
      },
      "user_currently_active"
    )

    await runBootstrapSync({ workspaceId: "ws_1", streamId, messageId: null, workosUserId })

    const accountDb = new ThreaDatabase(accountDbName(workosUserId))
    expect(await accountDb.events.where("streamId").equals(streamId).toArray()).toEqual([])
    // Only the identity probe ran; no workspace or stream data was fetched.
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual(["/api/auth/me"])
  })

  it("states the recipient account on every prefetch request, so a switch after the owner check is refused", async () => {
    // The owner check reads the cookie once; the account can move before the
    // prefetch requests go out. They carry the recipient, so the server refuses
    // them (409) instead of answering as whoever the cookie names now — and a
    // refused response is never written under the recipient's key.
    const workosUserId = "user_asserting"
    const streamId = "stream_asserted"
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init
      const url = String(input)
      if (url.includes("/api/auth/me")) {
        return new Response(JSON.stringify({ id: workosUserId }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      return new Response(JSON.stringify({ error: "mismatch", code: "ACCOUNT_MISMATCH" }), { status: 409 })
    })
    vi.stubGlobal("fetch", fetchMock)

    await runBootstrapSync({ workspaceId: "ws_1", streamId, messageId: "evt_a1", workosUserId })

    const prefetchCalls = fetchMock.mock.calls.filter((call) => !String(call[0]).includes("/api/auth/me"))
    expect(prefetchCalls.length).toBeGreaterThan(0)
    for (const call of prefetchCalls) {
      const headers = call[1]?.headers as Record<string, string> | undefined
      expect(headers?.[ACCOUNT_ASSERTION_HEADER]).toBe(workosUserId)
    }
    const accountDb = new ThreaDatabase(accountDbName(workosUserId))
    expect(await accountDb.events.where("streamId").equals(streamId).toArray()).toEqual([])
  })

  it("prefetches nothing when the target carries no account id", async () => {
    const streamId = "stream_noacct1"
    const fetchMock = mockFetch(
      {
        [`/streams/${streamId}/bootstrap`]: {
          stream: { id: streamId, workspaceId: "ws_1", type: "channel", slug: "general" },
          events: [makeEvent({ id: "evt_n1", streamId, sequence: "1" })],
        },
      },
      "user_someone"
    )

    await runBootstrapSync({ workspaceId: "ws_1", streamId, messageId: "evt_n1", workosUserId: null })

    const defaultEvents = await db.events.where("streamId").equals(streamId).toArray()
    expect(defaultEvents).toEqual([])
    // Nothing is fetched at all: an unattributed target has no owner to write
    // under, and the workspace snapshot is as viewer-specific as the stream one.
    expect(fetchMock.mock.calls).toEqual([])
  })

  it("persists the bootstrap's canonical slot carrier into the account database", async () => {
    const workosUserId = "user_acct_slots"
    const streamId = "stream_slots1"
    mockFetch(
      {
        [`/streams/${streamId}/bootstrap`]: {
          stream: { id: streamId, workspaceId: "ws_1", type: "channel", slug: "general" },
          events: [makeEvent({ id: "evt_s1", streamId, sequence: "1" })],
          slots: { [sharedMessageSlotKey("msg_src")]: missingSlot("msg_src") },
        },
      },
      workosUserId
    )

    await runBootstrapSync({ workspaceId: "ws_1", streamId, messageId: null, workosUserId })

    const accountDb = new ThreaDatabase(accountDbName(workosUserId))
    const rows = await accountDb.slots.where("streamId").equals(streamId).toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ slotKey: sharedMessageSlotKey("msg_src"), value: missingSlot("msg_src") })
  })

  it("rekeys a legacy-only bootstrap carrier and merges events-around slots", async () => {
    const workosUserId = "user_acct_slots_legacy"
    const streamId = "stream_slots2"
    mockFetch(
      {
        [`/streams/${streamId}/bootstrap`]: {
          stream: { id: streamId, workspaceId: "ws_1", type: "channel", slug: "general" },
          events: [makeEvent({ id: "evt_old", streamId, sequence: "1" })],
          sharedMessages: { msg_bootstrap: missingSlot("msg_bootstrap") },
        },
        "/events/around": {
          events: [makeEvent({ id: "evt_pushed", streamId, sequence: "9" })],
          slots: { [sharedMessageSlotKey("msg_around")]: missingSlot("msg_around") },
        },
      },
      workosUserId
    )

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

    mockFetch(
      {
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
      },
      workosUserId
    )

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
  const PATH = "https://app.threa.io/api/workspaces/ws_1/bootstrap"
  const keyFor = (workosUserId: string) => `${PATH}?account=${workosUserId}`
  const requestAs = (workosUserId: string, init?: RequestInit & { extraParams?: string }) =>
    new Request(`${PATH}?account=${workosUserId}${init?.extraParams ?? ""}`, init)

  /** Minimal Cache stand-in — jsdom has no CacheStorage. */
  function fakeCache(seed?: Record<string, Response>) {
    const store = new Map<string, Response>(Object.entries(seed ?? {}))
    return {
      store,
      match: vi.fn(async (key: string) => store.get(key)),
      delete: vi.fn(async (key: string) => store.delete(key)),
    } as unknown as Cache & { store: Map<string, Response> }
  }

  it("serves the pre-fetched copy once, then drops it", async () => {
    const cache = fakeCache({ [keyFor("user_a")]: new Response("cached") })
    const fetchImpl = vi.fn(async () => new Response("network"))

    const res = await respondToBootstrapRequest(requestAs("user_a"), cache, fetchImpl)

    expect(await res.text()).toBe("cached")
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(cache.delete).toHaveBeenCalledWith(keyFor("user_a"))
  })

  it("never answers one account from another account's pre-fetched snapshot", async () => {
    // A workspace snapshot is viewer-specific — stream membership, read state,
    // DM names. Two accounts on this browser can both be members of the same
    // workspace, so a URL-only key handed the second one the first one's view
    // of it, private scratchpads included.
    const cache = fakeCache({
      [keyFor("user_a")]: new Response(JSON.stringify({ streams: [{ id: "stream_a_private" }] })),
    })
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ streams: [] })))

    const res = await respondToBootstrapRequest(requestAs("user_b"), cache, fetchImpl)

    expect(await res.json()).toEqual({ streams: [] })
    expect(fetchImpl).toHaveBeenCalled()
    // A's copy is still A's: isolation, not deletion.
    expect(cache.store.has(keyFor("user_a"))).toBe(true)
  })

  it("goes to the network when the request names no account (a page from before the flag)", async () => {
    const cache = fakeCache({ [keyFor("user_a")]: new Response("cached") })
    const fetchImpl = vi.fn(async () => new Response("network"))

    const res = await respondToBootstrapRequest(new Request(PATH), cache, fetchImpl)

    expect(await res.text()).toBe("network")
    expect(cache.store.has(keyFor("user_a"))).toBe(true)
  })

  it("goes to the network when nothing is pre-fetched", async () => {
    const cache = fakeCache()
    const fetchImpl = vi.fn(async () => new Response("network"))

    expect(await (await respondToBootstrapRequest(requestAs("user_a"), cache, fetchImpl)).text()).toBe("network")
    expect(fetchImpl).toHaveBeenCalled()
  })

  it("refuses the pre-fetched copy for a fresh-flagged request, matching the unflagged cache key", async () => {
    // The flag rides in the URL because `Request.cache` fidelity inside a
    // service worker varies by engine, and the uncertain engines are phones —
    // the devices this protects. The entry is stored without the flag, so the
    // lookup must strip it before deleting.
    const cache = fakeCache({ [keyFor("user_a")]: new Response("cached") })
    const fetchImpl = vi.fn(async () => new Response("network"))

    const res = await respondToBootstrapRequest(requestAs("user_a", { extraParams: "&fresh=1" }), cache, fetchImpl)

    expect(await res.text()).toBe("network")
    expect(cache.store.has(keyFor("user_a"))).toBe(false)
  })

  it("refuses the pre-fetched copy for a no-store request and discards it", async () => {
    // The caller is about to stamp a sync cursor against this snapshot, so a
    // copy captured when the tab last hid would strand every entry since. It
    // must also be deleted, not merely skipped — otherwise the next request
    // with the same expectation is handed the same stale copy.
    const cache = fakeCache({ [keyFor("user_a")]: new Response("cached") })
    const fetchImpl = vi.fn(async () => new Response("network"))

    const res = await respondToBootstrapRequest(requestAs("user_a", { cache: "no-store" }), cache, fetchImpl)

    expect(await res.text()).toBe("network")
    expect(cache.store.has(keyFor("user_a"))).toBe(false)
  })
})
