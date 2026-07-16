import { afterEach, expect, spyOn, test } from "bun:test"
import { ThreaApiClient } from "./api-client"
import { enrichConversation, enrichMessages } from "./enrich"
import { RefResolver } from "./resolver"
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

const USERS = {
  data: [
    { id: "usr_p", name: "Pierre Boberg", slug: "pierre-boberg", email: "p@x.io", role: "member" },
    { id: "usr_k", name: "Kris", slug: "kris", email: "k@x.io", role: "admin" },
  ],
}

test("enrichMessages attaches author id/type/name/slug from the cached users list", async () => {
  fetchSpy.mockImplementation(fetchByPath(() => jsonResponse(200, USERS)))
  const resolver = makeResolver()

  const rows = [{ id: "msg_1", authorId: "usr_p", authorType: "user", content: "hi" }]
  const enriched = (await enrichMessages(rows, resolver)) as Array<Record<string, unknown>>

  expect(enriched[0]!.author).toEqual({ id: "usr_p", type: "user", name: "Pierre Boberg", slug: "pierre-boberg" })
  // Original fields are preserved.
  expect(enriched[0]!.content).toBe("hi")
})

test("enrichMessages falls back to authorDisplayName for a bot author absent from /users, omitting slug", async () => {
  fetchSpy.mockImplementation(fetchByPath(() => jsonResponse(200, USERS)))
  const resolver = makeResolver()

  const rows = [{ id: "msg_2", authorId: "bot_1", authorType: "bot", authorDisplayName: "Ariadne" }]
  const enriched = (await enrichMessages(rows, resolver)) as Array<Record<string, unknown>>

  expect(enriched[0]!.author).toEqual({ id: "bot_1", type: "bot", name: "Ariadne" })
})

test("enrichMessages does not fetch users when no row carries an authorId", async () => {
  const resolver = makeResolver()
  const rows = [{ id: "msg_3", sequence: "42" }]

  const enriched = await enrichMessages(rows, resolver)

  expect(enriched).toEqual(rows)
  expect(fetchSpy).not.toHaveBeenCalled()
})

test("enrichMessages degrades to the raw rows when the users fetch fails", async () => {
  fetchSpy.mockImplementation(fetchByPath(() => jsonResponse(500, { error: "boom", code: "INTERNAL" })))
  const resolver = makeResolver()

  const rows = [{ id: "msg_4", authorId: "usr_p", authorType: "user" }]
  const enriched = await enrichMessages(rows, resolver)

  expect(enriched).toEqual(rows)
})

test("enrichConversation mirrors participantIds into a participants array with name/slug", async () => {
  fetchSpy.mockImplementation(fetchByPath(() => jsonResponse(200, USERS)))
  const resolver = makeResolver()

  const conv = { id: "conv_1", participantIds: ["usr_p", "usr_k", "bot_x"] }
  const enriched = (await enrichConversation(conv, resolver)) as Record<string, unknown>

  expect(enriched.participants).toEqual([
    { id: "usr_p", name: "Pierre Boberg", slug: "pierre-boberg" },
    { id: "usr_k", name: "Kris", slug: "kris" },
    { id: "bot_x" },
  ])
  expect(enriched.participantIds).toEqual(["usr_p", "usr_k", "bot_x"])
})

test("enrichConversation degrades to the raw conversation when the users fetch fails", async () => {
  fetchSpy.mockImplementation(fetchByPath(() => jsonResponse(500, { error: "boom" })))
  const resolver = makeResolver()

  const conv = { id: "conv_1", participantIds: ["usr_p"] }
  const enriched = await enrichConversation(conv, resolver)

  expect(enriched).toEqual(conv)
})
