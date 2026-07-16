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

test("list_conversations maps stream_id/cursor to wire params and passes the envelope through incl. cursor", async () => {
  fetchSpy.mockResolvedValue(jsonResponse(200, { data: [{ id: "conv_1" }], hasMore: true, cursor: "cur_2" }))
  const client = await connectClient()

  const tools = await client.listTools()
  expect(tools.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["list_conversations", "read_conversation"]))

  const result = (await client.callTool({
    name: "list_conversations",
    arguments: { stream_id: "stream_1", status: "active", cursor: "cur_1", limit: 30 },
  })) as CallToolResult
  expect(result.isError).toBeFalsy()

  const url = new URL(String(fetchSpy.mock.calls[0]?.[0]))
  expect(url.pathname).toBe("/api/v1/workspaces/ws_1/conversations")
  expect(url.searchParams.get("streamId")).toBe("stream_1")
  expect(url.searchParams.get("status")).toBe("active")
  expect(url.searchParams.get("after")).toBe("cur_1")
  expect(url.searchParams.get("limit")).toBe("30")
  expect(url.searchParams.has("cursor")).toBe(false)

  expect(textPayload(result)).toEqual({ data: [{ id: "conv_1" }], hasMore: true, cursor: "cur_2" })
})

test("read_conversation fetches the conversation and its messages concurrently and maps cursor to `after`", async () => {
  fetchSpy.mockImplementation(
    fetchByPath((path) =>
      path.endsWith("/messages")
        ? jsonResponse(200, { data: [{ id: "msg_1", streamId: "stream_1" }], hasMore: true, cursor: "cur_9" })
        : jsonResponse(200, { data: { id: "conv_1", status: "active" } })
    )
  )
  const client = await connectClient()

  const result = (await client.callTool({
    name: "read_conversation",
    arguments: { conversation_id: "conv_1", cursor: "cur_5", limit: 15 },
  })) as CallToolResult
  expect(result.isError).toBeFalsy()

  const paths = calledPaths()
  expect(paths).toContain("/api/v1/workspaces/ws_1/conversations/conv_1")
  const messagesCall = fetchSpy.mock.calls.find((call) => new URL(String(call[0])).pathname.endsWith("/messages"))
  const messagesUrl = new URL(String(messagesCall?.[0]))
  expect(messagesUrl.pathname).toBe("/api/v1/workspaces/ws_1/conversations/conv_1/messages")
  expect(messagesUrl.searchParams.get("after")).toBe("cur_5")
  expect(messagesUrl.searchParams.get("limit")).toBe("15")

  expect(textPayload(result)).toEqual({
    conversation: { id: "conv_1", status: "active" },
    messages: { data: [{ id: "msg_1", streamId: "stream_1" }], hasMore: true, cursor: "cur_9" },
  })
})

test("read_conversation errors as a whole when the conversation fetch fails", async () => {
  fetchSpy.mockImplementation(
    fetchByPath((path) =>
      path.endsWith("/messages")
        ? jsonResponse(200, { data: [], hasMore: false })
        : jsonResponse(404, { error: "gone", code: "NOT_FOUND" })
    )
  )
  const client = await connectClient()

  const result = (await client.callTool({
    name: "read_conversation",
    arguments: { conversation_id: "conv_x" },
  })) as CallToolResult

  expect(result.isError).toBe(true)
  const payload = textPayload(result)
  expect(payload.code).toBe("NOT_FOUND")
  expect(payload.conversation).toBeUndefined()
})
