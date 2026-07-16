import { afterEach, expect, spyOn, test } from "bun:test"
import { ThreaApiClient } from "./api-client"
import { RefResolver } from "./resolver"
import { UnresolvedRefError } from "./tools/result"
import { TEST_CONFIG, fetchByPath, jsonResponse } from "./test-support"

const fetchSpy = spyOn(globalThis, "fetch")

afterEach(() => {
  fetchSpy.mockReset()
})

function makeResolver(): RefResolver {
  const client = new ThreaApiClient({
    baseUrl: TEST_CONFIG.baseUrl,
    workspaceId: TEST_CONFIG.workspaceId,
    apiKey: TEST_CONFIG.apiKey,
  })
  return new RefResolver({ client })
}

test("resolveStream passes a stream_ id through without any fetch", async () => {
  const resolver = makeResolver()
  const id = await resolver.resolveStream("stream_abc")
  expect(id).toBe("stream_abc")
  expect(fetchSpy).not.toHaveBeenCalled()
})

test("resolveStream resolves a #channel-slug by exact slug match and caches the hit", async () => {
  fetchSpy.mockImplementation(
    fetchByPath(() =>
      jsonResponse(200, {
        data: [
          { id: "stream_other", slug: "general-chat", displayName: "#general-chat" },
          { id: "stream_gen", slug: "general", displayName: "#general" },
        ],
        hasMore: false,
      })
    )
  )
  const resolver = makeResolver()

  expect(await resolver.resolveStream("#general")).toBe("stream_gen")
  expect(fetchSpy.mock.calls.length).toBe(1)
  const url = new URL(String(fetchSpy.mock.calls[0]?.[0]))
  expect(url.pathname).toBe("/api/v1/workspaces/ws_1/streams")
  expect(url.searchParams.get("type")).toBe("channel")
  expect(url.searchParams.get("query")).toBe("general")

  // Second resolution is served from cache, no extra fetch.
  expect(await resolver.resolveStream("#general")).toBe("stream_gen")
  expect(fetchSpy.mock.calls.length).toBe(1)
})

test("resolveStream reports candidates when a #channel-slug is ambiguous", async () => {
  fetchSpy.mockImplementation(
    fetchByPath(() =>
      jsonResponse(200, {
        data: [
          { id: "stream_a", slug: "general", displayName: "#general" },
          { id: "stream_b", slug: "general", displayName: "#general" },
        ],
        hasMore: false,
      })
    )
  )
  const resolver = makeResolver()

  const promise = resolver.resolveStream("#general")
  await expect(promise).rejects.toBeInstanceOf(UnresolvedRefError)
  await expect(promise).rejects.toThrow(/stream_a/)
  await expect(promise).rejects.toThrow(/stream_b/)
})

test("resolveStream errors when no channel matches the slug", async () => {
  fetchSpy.mockImplementation(fetchByPath(() => jsonResponse(200, { data: [], hasMore: false })))
  const resolver = makeResolver()

  const promise = resolver.resolveStream("#nope")
  await expect(promise).rejects.toBeInstanceOf(UnresolvedRefError)
  await expect(promise).rejects.toThrow(/list_streams/)
})

test("resolveUser passes usr_ and bot_ ids through without any fetch", async () => {
  const resolver = makeResolver()
  expect(await resolver.resolveUser("usr_1")).toBe("usr_1")
  expect(await resolver.resolveUser("bot_1")).toBe("bot_1")
  expect(fetchSpy).not.toHaveBeenCalled()
})

// The public /users endpoint filters `query` by name/email ILIKE only, never slug
// (apps/backend/src/features/workspaces/user-repository.ts listByWorkspace). A stub
// that ignores `query` would mask a slug resolver that wrongly relies on it, so these
// stubs replicate the real filter and return the roster only on the unfiltered page.
const USER_ROSTER = [
  { id: "usr_p", name: "Pierre Boberg", slug: "pierre-boberg" },
  { id: "usr_q", name: "Pierre Other", slug: "pierre-other" },
]

function usersByContract(path: string, query: string | null): Response {
  if (path !== "/api/v1/workspaces/ws_1/users") return jsonResponse(404, { error: "unexpected path" })
  if (query === null) return jsonResponse(200, { data: USER_ROSTER })
  const needle = query.toLowerCase()
  const matched = USER_ROSTER.filter((u) => u.name.toLowerCase().includes(needle))
  return jsonResponse(200, { data: matched })
}

test("resolveUser resolves an @user-slug against the unfiltered roster and caches", async () => {
  fetchSpy.mockImplementation((async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    return usersByContract(url.pathname, url.searchParams.get("query"))
  }) as unknown as typeof fetch)
  const resolver = makeResolver()

  expect(await resolver.resolveUser("@pierre-boberg")).toBe("usr_p")
  expect(fetchSpy.mock.calls.length).toBe(1)
  // The resolver must not query by slug — that would return an empty page.
  expect(new URL(String(fetchSpy.mock.calls[0]?.[0])).searchParams.get("query")).toBeNull()
  expect(await resolver.resolveUser("@pierre-boberg")).toBe("usr_p")
  expect(fetchSpy.mock.calls.length).toBe(1)
})

test("resolveUser errors when no user matches the slug", async () => {
  fetchSpy.mockImplementation(fetchByPath(() => jsonResponse(200, { data: [] })))
  const resolver = makeResolver()

  const promise = resolver.resolveUser("@ghost")
  await expect(promise).rejects.toBeInstanceOf(UnresolvedRefError)
  await expect(promise).rejects.toThrow(/list_users/)
})

test("resolveStream @user-slug resolves the user then errors that the DM is not queryable, naming the id", async () => {
  fetchSpy.mockImplementation((async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    return usersByContract(url.pathname, url.searchParams.get("query"))
  }) as unknown as typeof fetch)
  const resolver = makeResolver()

  const promise = resolver.resolveStream("@pierre-boberg")
  await expect(promise).rejects.toBeInstanceOf(UnresolvedRefError)
  await expect(promise).rejects.toThrow(/usr_p/)
  await expect(promise).rejects.toThrow(/list_streams/)
})

test("allUsers dedupes concurrent cold-cache calls into a single fetch", async () => {
  let calls = 0
  fetchSpy.mockImplementation((async () => {
    calls += 1
    await new Promise((resolve) => setTimeout(resolve, 5))
    return jsonResponse(200, { data: USER_ROSTER })
  }) as unknown as typeof fetch)
  const resolver = makeResolver()

  const [a, b, c] = await Promise.all([resolver.allUsers(), resolver.allUsers(), resolver.allUsers()])
  expect(calls).toBe(1)
  expect(a).toEqual(USER_ROSTER)
  expect(b).toEqual(USER_ROSTER)
  expect(c).toEqual(USER_ROSTER)
})

test("allUsers refetches after an in-flight fetch rejects", async () => {
  let calls = 0
  fetchSpy.mockImplementation((async () => {
    calls += 1
    if (calls === 1) return jsonResponse(500, { error: "boom" })
    return jsonResponse(200, { data: USER_ROSTER })
  }) as unknown as typeof fetch)
  const resolver = makeResolver()

  await expect(resolver.allUsers()).rejects.toBeDefined()
  expect(await resolver.allUsers()).toEqual(USER_ROSTER)
  expect(calls).toBe(2)
})

test("resolveStreams resolves a mix of ids and slugs in one pass", async () => {
  fetchSpy.mockImplementation(
    fetchByPath(() => jsonResponse(200, { data: [{ id: "stream_gen", slug: "general", displayName: "#general" }] }))
  )
  const resolver = makeResolver()

  expect(await resolver.resolveStreams(["stream_x", "#general"])).toEqual(["stream_x", "stream_gen"])
})
