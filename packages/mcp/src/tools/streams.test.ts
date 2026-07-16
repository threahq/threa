import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { afterEach, expect, spyOn, test } from "bun:test"
import { connectClient, jsonResponse, textPayload } from "../test-support"

const fetchSpy = spyOn(globalThis, "fetch")

afterEach(() => {
  fetchSpy.mockReset()
})

function requestUrl(): URL {
  const first = fetchSpy.mock.calls[0]?.[0]
  return new URL(String(first))
}

test("list_streams maps args to the wire query and passes the list envelope through incl. cursor", async () => {
  fetchSpy.mockResolvedValue(jsonResponse(200, { data: [{ id: "stream_1" }], hasMore: true, cursor: "cur_2" }))
  const client = await connectClient()

  const tools = await client.listTools()
  expect(tools.tools.map((t) => t.name)).toEqual(
    expect.arrayContaining(["list_streams", "get_stream", "list_stream_members"])
  )

  const result = (await client.callTool({
    name: "list_streams",
    arguments: { type: ["channel", "dm"], query: "eng", after: "cur_1", limit: 25 },
  })) as CallToolResult
  expect(result.isError).toBeFalsy()

  const url = requestUrl()
  expect(url.pathname).toBe("/api/v1/workspaces/ws_1/streams")
  expect(url.searchParams.getAll("type")).toEqual(["channel", "dm"])
  expect(url.searchParams.get("query")).toBe("eng")
  expect(url.searchParams.get("after")).toBe("cur_1")
  expect(url.searchParams.get("limit")).toBe("25")

  const payload = textPayload(result)
  expect(payload).toEqual({ data: [{ id: "stream_1" }], hasMore: true, cursor: "cur_2" })
})

test("list_stream_members maps the cursor arg to the wire `after` param", async () => {
  fetchSpy.mockResolvedValue(jsonResponse(200, { data: [], hasMore: false, cursor: null }))
  const client = await connectClient()

  await client.callTool({
    name: "list_stream_members",
    arguments: { stream_id: "stream_9", cursor: "cur_5", limit: 10 },
  })

  const url = requestUrl()
  expect(url.pathname).toBe("/api/v1/workspaces/ws_1/streams/stream_9/members")
  expect(url.searchParams.get("after")).toBe("cur_5")
  expect(url.searchParams.get("limit")).toBe("10")
  expect(url.searchParams.has("cursor")).toBe(false)
})

test("get_stream surfaces a 404 as an isError result carrying the scope hint", async () => {
  fetchSpy.mockResolvedValue(jsonResponse(404, { error: "gone", code: "NOT_FOUND" }))
  const client = await connectClient()

  const result = (await client.callTool({
    name: "get_stream",
    arguments: { stream_id: "stream_x" },
  })) as CallToolResult
  expect(result.isError).toBe(true)
  const payload = textPayload(result)
  expect(payload.code).toBe("NOT_FOUND")
  expect(payload.hint).toMatch(/scope/i)
})
