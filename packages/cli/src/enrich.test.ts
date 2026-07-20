import { afterEach, expect, spyOn, test } from "bun:test"
import { ThreaApiClient } from "./api-client"
import { enrichConversation, enrichMessages, enrichStreamContext } from "./enrich"
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

const STREAMS: Record<string, unknown> = {
  stream_root: { id: "stream_root", type: "channel", displayName: "engineering" },
  stream_thread: { id: "stream_thread", type: "thread", displayName: "deploy plan", rootStreamId: "stream_root" },
}

function streamFetch(path: string) {
  const id = path.split("/").pop()!
  const stream = STREAMS[id]
  return stream ? jsonResponse(200, { data: stream }) : jsonResponse(404, { error: "nope", code: "NOT_FOUND" })
}

test("enrichStreamContext attaches stream and rootStream refs for thread rows", async () => {
  fetchSpy.mockImplementation(fetchByPath(streamFetch))
  const resolver = makeResolver()

  const rows = [
    { id: "msg_1", streamId: "stream_thread" },
    { id: "msg_2", streamId: "stream_root" },
  ]
  const enriched = (await enrichStreamContext(rows, resolver)) as Array<Record<string, unknown>>

  expect(enriched[0]!.stream).toEqual({ id: "stream_thread", name: "deploy plan", type: "thread" })
  expect(enriched[0]!.rootStream).toEqual({ id: "stream_root", name: "engineering", type: "channel" })
  expect(enriched[1]!.stream).toEqual({ id: "stream_root", name: "engineering", type: "channel" })
  expect(enriched[1]!.rootStream).toBeUndefined()
  // Deduped: stream_thread + stream_root fetched once each.
  expect(fetchSpy.mock.calls.length).toBe(2)
})

test("enrichStreamContext uses a row's own rootStreamId (conversations) and degrades to bare ids on fetch failure", async () => {
  fetchSpy.mockImplementation(fetchByPath(() => jsonResponse(500, { error: "boom", code: "INTERNAL" })))
  const resolver = makeResolver()

  const rows = [{ id: "conv_1", streamId: "stream_thread", rootStreamId: "stream_root" }]
  const enriched = (await enrichStreamContext(rows, resolver)) as Array<Record<string, unknown>>

  expect(enriched[0]!.stream).toEqual({ id: "stream_thread" })
  expect(enriched[0]!.rootStream).toEqual({ id: "stream_root" })
})

test("enrichStreamContext passes rows without streamId through untouched", async () => {
  const resolver = makeResolver()
  const rows = [{ id: "memo_1" }]

  expect(await enrichStreamContext(rows, resolver)).toEqual(rows)
  expect(fetchSpy).not.toHaveBeenCalled()
})

test("enrichConversation degrades to the raw conversation when the users fetch fails", async () => {
  fetchSpy.mockImplementation(fetchByPath(() => jsonResponse(500, { error: "boom" })))
  const resolver = makeResolver()

  const conv = { id: "conv_1", participantIds: ["usr_p"] }
  const enriched = await enrichConversation(conv, resolver)

  expect(enriched).toEqual(conv)
})
