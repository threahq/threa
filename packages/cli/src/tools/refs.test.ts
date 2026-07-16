import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { afterEach, expect, spyOn, test } from "bun:test"
import { connectClient, fetchByPath, jsonResponse, textPayload } from "../test-support"

const fetchSpy = spyOn(globalThis, "fetch")

afterEach(() => {
  fetchSpy.mockReset()
})

const STREAMS_LIST = "/api/v1/workspaces/ws_1/streams"
const USERS = {
  data: [{ id: "usr_p", name: "Pierre Boberg", slug: "pierre-boberg", email: "p@x.io", role: "member" }],
}
const CHANNEL_HIT = {
  data: [{ id: "stream_gen", slug: "general", displayName: "#general" }],
  hasMore: false,
}

function calledPaths(): string[] {
  return fetchSpy.mock.calls.map((call) => new URL(String(call[0])).pathname)
}

test("read_stream accepts a #channel-slug, reads the resolved stream, and enriches message authors", async () => {
  fetchSpy.mockImplementation(
    fetchByPath((path) => {
      if (path === STREAMS_LIST) return jsonResponse(200, CHANNEL_HIT)
      if (path.endsWith("/users")) return jsonResponse(200, USERS)
      if (path.endsWith("/messages")) {
        return jsonResponse(200, {
          data: [{ id: "msg_1", authorId: "usr_p", authorType: "user", content: "hi" }],
          hasMore: false,
        })
      }
      return jsonResponse(200, { data: { id: "stream_gen", type: "channel" } })
    })
  )
  const client = await connectClient()

  const result = (await client.callTool({
    name: "read_stream",
    arguments: { stream_id: "#general" },
  })) as CallToolResult
  expect(result.isError).toBeFalsy()

  expect(calledPaths()).toContain("/api/v1/workspaces/ws_1/streams/stream_gen")
  const payload = textPayload(result) as { messages: { data: Array<Record<string, unknown>> } }
  expect(payload.messages.data[0]!.author).toEqual({
    id: "usr_p",
    type: "user",
    name: "Pierre Boberg",
    slug: "pierre-boberg",
  })
})

test("read_stream members already carry name and slug from the API (self-descriptive)", async () => {
  fetchSpy.mockImplementation(
    fetchByPath((path) => {
      if (path.endsWith("/members")) {
        return jsonResponse(200, {
          data: [{ userId: "usr_p", name: "Pierre Boberg", slug: "pierre-boberg", joinedAt: "2026-01-01T00:00:00Z" }],
          hasMore: false,
          cursor: null,
        })
      }
      if (path.endsWith("/messages")) return jsonResponse(200, { data: [], hasMore: false })
      return jsonResponse(200, { data: { id: "stream_1" } })
    })
  )
  const client = await connectClient()

  const result = (await client.callTool({
    name: "read_stream",
    arguments: { stream_id: "stream_1", include_members: true },
  })) as CallToolResult
  expect(result.isError).toBeFalsy()

  const payload = textPayload(result) as { members: { data: Array<Record<string, unknown>> } }
  expect(payload.members.data[0]).toMatchObject({ userId: "usr_p", name: "Pierre Boberg", slug: "pierre-boberg" })
})

test("read_stream degrades gracefully when enrichment's users fetch fails", async () => {
  fetchSpy.mockImplementation(
    fetchByPath((path) => {
      if (path.endsWith("/users")) return jsonResponse(500, { error: "boom", code: "INTERNAL" })
      if (path.endsWith("/messages")) {
        return jsonResponse(200, { data: [{ id: "msg_1", authorId: "usr_p", authorType: "user" }], hasMore: false })
      }
      return jsonResponse(200, { data: { id: "stream_1" } })
    })
  )
  const client = await connectClient()

  const result = (await client.callTool({
    name: "read_stream",
    arguments: { stream_id: "stream_1" },
  })) as CallToolResult

  expect(result.isError).toBeFalsy()
  const payload = textPayload(result) as { messages: { data: Array<Record<string, unknown>> } }
  expect(payload.messages.data[0]!.author).toBeUndefined()
  expect(payload.messages.data[0]!.authorId).toBe("usr_p")
})

test("send_message accepts a #channel-slug and posts to the resolved stream path", async () => {
  fetchSpy.mockImplementation(
    fetchByPath((path) => {
      if (path === STREAMS_LIST) return jsonResponse(200, CHANNEL_HIT)
      return jsonResponse(201, { data: { id: "msg_new" } })
    })
  )
  const client = await connectClient()

  const result = (await client.callTool({
    name: "send_message",
    arguments: { stream_id: "#general", content: "hello" },
  })) as CallToolResult
  expect(result.isError).toBeFalsy()

  const postCall = fetchSpy.mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === "POST")
  expect(new URL(String(postCall?.[0])).pathname).toBe("/api/v1/workspaces/ws_1/streams/stream_gen/messages")
})

test("a stream tool errors with UNRESOLVED_REF when given an @user-slug (DM not queryable)", async () => {
  fetchSpy.mockImplementation(
    fetchByPath((path) => {
      if (path.endsWith("/users")) return jsonResponse(200, USERS)
      return jsonResponse(200, { data: { id: "stream_x" } })
    })
  )
  const client = await connectClient()

  const result = (await client.callTool({
    name: "read_stream",
    arguments: { stream_id: "@pierre-boberg" },
  })) as CallToolResult

  expect(result.isError).toBe(true)
  const payload = textPayload(result)
  expect(payload.code).toBe("UNRESOLVED_REF")
  expect(String(payload.message)).toContain("usr_p")
  // The main read never fired: no single-stream GET happened.
  expect(calledPaths().some((p) => p === "/api/v1/workspaces/ws_1/streams/stream_x")).toBe(false)
})
