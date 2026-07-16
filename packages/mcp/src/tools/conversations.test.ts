import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { afterEach, expect, spyOn, test } from "bun:test"
import { connectClient, jsonResponse, textPayload } from "../test-support"

const fetchSpy = spyOn(globalThis, "fetch")

afterEach(() => {
  fetchSpy.mockReset()
})

function requestUrl(): URL {
  return new URL(String(fetchSpy.mock.calls[0]?.[0]))
}

test("list_conversations maps stream_id/cursor to wire params and passes the envelope through incl. cursor", async () => {
  fetchSpy.mockResolvedValue(jsonResponse(200, { data: [{ id: "conv_1" }], hasMore: true, cursor: "cur_2" }))
  const client = await connectClient()

  const tools = await client.listTools()
  expect(tools.tools.map((t) => t.name)).toEqual(
    expect.arrayContaining(["list_conversations", "get_conversation", "get_conversation_messages"])
  )

  const result = (await client.callTool({
    name: "list_conversations",
    arguments: { stream_id: "stream_1", status: "active", cursor: "cur_1", limit: 30 },
  })) as CallToolResult
  expect(result.isError).toBeFalsy()

  const url = requestUrl()
  expect(url.pathname).toBe("/api/v1/workspaces/ws_1/conversations")
  expect(url.searchParams.get("streamId")).toBe("stream_1")
  expect(url.searchParams.get("status")).toBe("active")
  expect(url.searchParams.get("after")).toBe("cur_1")
  expect(url.searchParams.get("limit")).toBe("30")
  expect(url.searchParams.has("cursor")).toBe(false)

  expect(textPayload(result)).toEqual({ data: [{ id: "conv_1" }], hasMore: true, cursor: "cur_2" })
})

test("get_conversation_messages maps the cursor arg to the wire `after` param", async () => {
  fetchSpy.mockResolvedValue(jsonResponse(200, { data: [], hasMore: false, cursor: null }))
  const client = await connectClient()

  await client.callTool({
    name: "get_conversation_messages",
    arguments: { conversation_id: "conv_9", cursor: "cur_5", limit: 15 },
  })

  const url = requestUrl()
  expect(url.pathname).toBe("/api/v1/workspaces/ws_1/conversations/conv_9/messages")
  expect(url.searchParams.get("after")).toBe("cur_5")
  expect(url.searchParams.get("limit")).toBe("15")
})

test("get_conversation surfaces a 404 as an isError result", async () => {
  fetchSpy.mockResolvedValue(jsonResponse(404, { error: "gone", code: "NOT_FOUND" }))
  const client = await connectClient()

  const result = (await client.callTool({
    name: "get_conversation",
    arguments: { conversation_id: "conv_x" },
  })) as CallToolResult
  expect(result.isError).toBe(true)
  expect(textPayload(result).code).toBe("NOT_FOUND")
})
