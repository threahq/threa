import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { afterEach, expect, spyOn, test } from "bun:test"
import { connectClient, fetchByPath, jsonResponse, textPayload } from "../test-support"

const fetchSpy = spyOn(globalThis, "fetch")

afterEach(() => {
  fetchSpy.mockReset()
})

function calledPaths(): string[] {
  return fetchSpy.mock.calls.map((call) => new URL(String(call[0])).pathname)
}

test("list_streams maps args to the wire query and passes the list envelope through incl. cursor", async () => {
  fetchSpy.mockResolvedValue(jsonResponse(200, { data: [{ id: "stream_1" }], hasMore: true, cursor: "cur_2" }))
  const client = await connectClient()

  const tools = await client.listTools()
  expect(tools.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["list_streams", "read_stream"]))

  const result = (await client.callTool({
    name: "list_streams",
    arguments: { type: ["channel", "dm"], query: "eng", after: "cur_1", limit: 25 },
  })) as CallToolResult
  expect(result.isError).toBeFalsy()

  const url = new URL(String(fetchSpy.mock.calls[0]?.[0]))
  expect(url.pathname).toBe("/api/v1/workspaces/ws_1/streams")
  expect(url.searchParams.getAll("type")).toEqual(["channel", "dm"])
  expect(url.searchParams.get("query")).toBe("eng")
  expect(url.searchParams.get("after")).toBe("cur_1")
  expect(url.searchParams.get("limit")).toBe("25")

  expect(textPayload(result)).toEqual({ data: [{ id: "stream_1" }], hasMore: true, cursor: "cur_2" })
})

test("read_stream fetches the stream and its messages concurrently and composes them", async () => {
  fetchSpy.mockImplementation(
    fetchByPath((path) =>
      path.endsWith("/messages")
        ? jsonResponse(200, { data: [{ id: "msg_1", sequence: "42" }], hasMore: true })
        : jsonResponse(200, { data: { id: "stream_1", name: "eng" } })
    )
  )
  const client = await connectClient()

  const result = (await client.callTool({
    name: "read_stream",
    arguments: { stream_id: "stream_1", before: "100", limit: 25 },
  })) as CallToolResult
  expect(result.isError).toBeFalsy()

  expect(calledPaths()).toContain("/api/v1/workspaces/ws_1/streams/stream_1")
  const messagesCall = fetchSpy.mock.calls.find((call) => new URL(String(call[0])).pathname.endsWith("/messages"))
  const messagesUrl = new URL(String(messagesCall?.[0]))
  expect(messagesUrl.pathname).toBe("/api/v1/workspaces/ws_1/streams/stream_1/messages")
  expect(messagesUrl.searchParams.get("before")).toBe("100")
  expect(messagesUrl.searchParams.get("limit")).toBe("25")

  expect(textPayload(result)).toEqual({
    stream: { id: "stream_1", name: "eng" },
    messages: { data: [{ id: "msg_1", sequence: "42" }], hasMore: true },
  })
})

test("read_stream includes members only when include_members is set, with the paged envelope", async () => {
  fetchSpy.mockImplementation(
    fetchByPath((path) => {
      if (path.endsWith("/messages")) return jsonResponse(200, { data: [], hasMore: false })
      if (path.endsWith("/members")) return jsonResponse(200, { data: [{ id: "usr_1" }], hasMore: false, cursor: null })
      return jsonResponse(200, { data: { id: "stream_1" } })
    })
  )
  const client = await connectClient()

  const result = (await client.callTool({
    name: "read_stream",
    arguments: { stream_id: "stream_1", include_members: true },
  })) as CallToolResult
  expect(result.isError).toBeFalsy()

  expect(calledPaths()).toContain("/api/v1/workspaces/ws_1/streams/stream_1/members")
  expect(textPayload(result)).toEqual({
    stream: { id: "stream_1" },
    messages: { data: [], hasMore: false },
    members: { data: [{ id: "usr_1" }], hasMore: false, cursor: null },
  })
})

test("read_stream omits the members fetch when include_members is not set", async () => {
  fetchSpy.mockImplementation(
    fetchByPath((path) =>
      path.endsWith("/messages")
        ? jsonResponse(200, { data: [], hasMore: false })
        : jsonResponse(200, { data: { id: "stream_1" } })
    )
  )
  const client = await connectClient()

  const result = (await client.callTool({
    name: "read_stream",
    arguments: { stream_id: "stream_1" },
  })) as CallToolResult
  expect(result.isError).toBeFalsy()

  expect(calledPaths().some((p) => p.endsWith("/members"))).toBe(false)
  expect(textPayload(result).members).toBeUndefined()
})

test("read_stream errors as a whole when the stream fetch fails and returns no partial data", async () => {
  fetchSpy.mockImplementation(
    fetchByPath((path) =>
      path.endsWith("/messages")
        ? jsonResponse(200, { data: [{ id: "msg_1" }], hasMore: false })
        : jsonResponse(404, { error: "gone", code: "NOT_FOUND" })
    )
  )
  const client = await connectClient()

  const result = (await client.callTool({
    name: "read_stream",
    arguments: { stream_id: "stream_x" },
  })) as CallToolResult

  expect(result.isError).toBe(true)
  const payload = textPayload(result)
  expect(payload.code).toBe("NOT_FOUND")
  expect(payload.hint).toMatch(/scope/i)
  expect(payload.stream).toBeUndefined()
  expect(payload.messages).toBeUndefined()
})

test("read_stream errors as a whole when the messages fetch fails", async () => {
  fetchSpy.mockImplementation(
    fetchByPath((path) =>
      path.endsWith("/messages")
        ? jsonResponse(500, { error: "boom", code: "INTERNAL" })
        : jsonResponse(200, { data: { id: "stream_1" } })
    )
  )
  const client = await connectClient()

  const result = (await client.callTool({
    name: "read_stream",
    arguments: { stream_id: "stream_1" },
  })) as CallToolResult

  expect(result.isError).toBe(true)
  expect(textPayload(result).code).toBe("INTERNAL")
})
