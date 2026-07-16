import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { afterEach, expect, spyOn, test } from "bun:test"
import { connectClient, jsonResponse, textPayload } from "../test-support"

const fetchSpy = spyOn(globalThis, "fetch")

afterEach(() => {
  fetchSpy.mockReset()
})

function requestInit(): RequestInit {
  return (fetchSpy.mock.calls[0]?.[1] ?? {}) as RequestInit
}

function requestBody(): Record<string, unknown> {
  return JSON.parse(String(requestInit().body)) as Record<string, unknown>
}

test("get_messages pages by numeric sequence and passes the cursor-less envelope through", async () => {
  fetchSpy.mockResolvedValue(jsonResponse(200, { data: [{ id: "msg_1", sequence: "42" }], hasMore: true }))
  const client = await connectClient()

  const result = (await client.callTool({
    name: "get_messages",
    arguments: { stream_id: "stream_1", before: "100", limit: 25 },
  })) as CallToolResult
  expect(result.isError).toBeFalsy()

  const url = new URL(String(fetchSpy.mock.calls[0]?.[0]))
  expect(url.pathname).toBe("/api/v1/workspaces/ws_1/streams/stream_1/messages")
  expect(url.searchParams.get("before")).toBe("100")
  expect(url.searchParams.get("limit")).toBe("25")
  expect(url.searchParams.has("after")).toBe(false)

  expect(textPayload(result)).toEqual({ data: [{ id: "msg_1", sequence: "42" }], hasMore: true })
})

test("search_messages maps stream_ids to the wire `streams` body field with the search flags", async () => {
  fetchSpy.mockResolvedValue(jsonResponse(200, { data: [{ id: "msg_2", rank: 0.9 }] }))
  const client = await connectClient()

  const result = (await client.callTool({
    name: "search_messages",
    arguments: {
      query: "deploy plan",
      semantic: true,
      exact: false,
      stream_ids: ["stream_1", "stream_2"],
      type: ["channel"],
      limit: 10,
    },
  })) as CallToolResult
  expect(result.isError).toBeFalsy()

  const init = requestInit()
  expect(init.method).toBe("POST")
  const url = new URL(String(fetchSpy.mock.calls[0]?.[0]))
  expect(url.pathname).toBe("/api/v1/workspaces/ws_1/messages/search")
  expect(requestBody()).toEqual({
    query: "deploy plan",
    semantic: true,
    exact: false,
    streams: ["stream_1", "stream_2"],
    type: ["channel"],
    limit: 10,
  })

  expect(textPayload(result)).toEqual({ data: [{ id: "msg_2", rank: 0.9 }] })
})

test("find_messages_by_metadata maps stream_id to the wire `streamId` body field", async () => {
  fetchSpy.mockResolvedValue(jsonResponse(200, { data: [] }))
  const client = await connectClient()

  await client.callTool({
    name: "find_messages_by_metadata",
    arguments: { metadata: { "github.pr": "org/repo#42" }, stream_id: "stream_7" },
  })

  const url = new URL(String(fetchSpy.mock.calls[0]?.[0]))
  expect(url.pathname).toBe("/api/v1/workspaces/ws_1/messages/find-by-metadata")
  expect(requestBody()).toEqual({ metadata: { "github.pr": "org/repo#42" }, streamId: "stream_7" })
})

test("send_message resumes an existing conversation and surfaces the returned conversationId", async () => {
  fetchSpy.mockResolvedValue(jsonResponse(201, { data: { id: "msg_9" }, conversationId: "conv_1" }))
  const client = await connectClient()

  const result = (await client.callTool({
    name: "send_message",
    arguments: {
      stream_id: "stream_1",
      content: "hello **world**",
      client_message_id: "cmid_fixed",
      metadata: { "github.pr": "org/repo#42" },
      conversation_id: "conv_1",
    },
  })) as CallToolResult
  expect(result.isError).toBeFalsy()

  const init = requestInit()
  expect(init.method).toBe("POST")
  const url = new URL(String(fetchSpy.mock.calls[0]?.[0]))
  expect(url.pathname).toBe("/api/v1/workspaces/ws_1/streams/stream_1/messages")
  expect(requestBody()).toEqual({
    content: "hello **world**",
    clientMessageId: "cmid_fixed",
    metadata: { "github.pr": "org/repo#42" },
    conversation: { intent: "existing", conversationId: "conv_1" },
  })

  const payload = textPayload(result)
  expect(payload.data).toEqual({ id: "msg_9" })
  expect(payload.conversationId).toBe("conv_1")
  expect(payload.clientMessageId).toBe("cmid_fixed")
})

test("send_message with start_conversation sends a new-intent directive and auto-generates a client message id", async () => {
  fetchSpy.mockResolvedValue(jsonResponse(201, { data: { id: "msg_10" }, conversationId: "conv_2" }))
  const client = await connectClient()

  const result = (await client.callTool({
    name: "send_message",
    arguments: { stream_id: "stream_1", content: "kickoff", start_conversation: true },
  })) as CallToolResult
  expect(result.isError).toBeFalsy()

  const body = requestBody()
  expect(body.conversation).toEqual({ intent: "new" })
  expect(String(body.clientMessageId)).toMatch(/^mcp-/)
  expect(textPayload(result).clientMessageId).toBe(body.clientMessageId)
})

test("send_message with both conversation_id and start_conversation errors before any HTTP call", async () => {
  const client = await connectClient()

  const result = (await client.callTool({
    name: "send_message",
    arguments: {
      stream_id: "stream_1",
      content: "ambiguous",
      conversation_id: "conv_1",
      start_conversation: true,
    },
  })) as CallToolResult

  expect(result.isError).toBe(true)
  expect(textPayload(result).code).toBe("INVALID_ARGUMENT")
  expect(fetchSpy).not.toHaveBeenCalled()
})

test("update_message round-trips the new content and returns the updated message", async () => {
  fetchSpy.mockResolvedValue(jsonResponse(200, { data: { id: "msg_1", content: "edited" } }))
  const client = await connectClient()

  const result = (await client.callTool({
    name: "update_message",
    arguments: { message_id: "msg_1", content: "edited" },
  })) as CallToolResult
  expect(result.isError).toBeFalsy()

  const init = requestInit()
  expect(init.method).toBe("PATCH")
  const url = new URL(String(fetchSpy.mock.calls[0]?.[0]))
  expect(url.pathname).toBe("/api/v1/workspaces/ws_1/messages/msg_1")
  expect(requestBody()).toEqual({ content: "edited" })
  expect(textPayload(result)).toEqual({ data: { id: "msg_1", content: "edited" } })
})

test("delete_message handles a 204 no-body response and reports the deletion", async () => {
  fetchSpy.mockResolvedValue(new Response(null, { status: 204 }))
  const client = await connectClient()

  const result = (await client.callTool({
    name: "delete_message",
    arguments: { message_id: "msg_1" },
  })) as CallToolResult
  expect(result.isError).toBeFalsy()

  const init = requestInit()
  expect(init.method).toBe("DELETE")
  const url = new URL(String(fetchSpy.mock.calls[0]?.[0]))
  expect(url.pathname).toBe("/api/v1/workspaces/ws_1/messages/msg_1")
  expect(textPayload(result)).toEqual({ deleted: true, message_id: "msg_1" })
})

test("search_messages surfaces an API error as an isError result", async () => {
  fetchSpy.mockResolvedValue(jsonResponse(400, { error: "query is required", code: "VALIDATION_ERROR" }))
  const client = await connectClient()

  const result = (await client.callTool({
    name: "search_messages",
    arguments: { query: "x" },
  })) as CallToolResult
  expect(result.isError).toBe(true)
  expect(textPayload(result).code).toBe("VALIDATION_ERROR")
})
