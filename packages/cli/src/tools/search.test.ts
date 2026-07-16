import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { afterEach, expect, spyOn, test } from "bun:test"
import { connectClient, jsonResponse, requestBody, requestInit, textPayload } from "../test-support"

const fetchSpy = spyOn(globalThis, "fetch")

afterEach(() => {
  fetchSpy.mockReset()
})

function requestPath(index = 0): string {
  return new URL(String(fetchSpy.mock.calls[index]?.[0])).pathname
}

test("search what=messages posts to /messages/search and maps stream_ids to `streams`", async () => {
  fetchSpy.mockResolvedValue(jsonResponse(200, { data: [{ id: "msg_1", rank: 0.9 }] }))
  const client = await connectClient()

  const result = (await client.callTool({
    name: "search",
    arguments: {
      what: "messages",
      query: "deploy plan",
      semantic: true,
      exact: false,
      stream_ids: ["stream_1", "stream_2"],
      type: ["channel"],
      limit: 10,
    },
  })) as CallToolResult
  expect(result.isError).toBeFalsy()

  expect(requestInit(fetchSpy).method).toBe("POST")
  expect(requestPath()).toBe("/api/v1/workspaces/ws_1/messages/search")
  expect(requestBody(fetchSpy)).toEqual({
    query: "deploy plan",
    semantic: true,
    exact: false,
    streams: ["stream_1", "stream_2"],
    type: ["channel"],
    limit: 10,
  })
  expect(textPayload(result)).toEqual({ data: [{ id: "msg_1", rank: 0.9 }] })
})

test("search what=memos posts to /memos/search, maps filter names, and allows an empty query", async () => {
  fetchSpy.mockResolvedValue(jsonResponse(200, { data: [{ memo: { id: "memo_1" } }] }))
  const client = await connectClient()

  const result = (await client.callTool({
    name: "search",
    arguments: {
      what: "memos",
      stream_ids: ["stream_1"],
      memo_type: ["conversation"],
      knowledge_type: ["procedure"],
      tags: ["deploy"],
      scope: "workspace",
      exact: false,
      limit: 5,
    },
  })) as CallToolResult
  expect(result.isError).toBeFalsy()

  expect(requestPath()).toBe("/api/v1/workspaces/ws_1/memos/search")
  expect(requestBody(fetchSpy)).toEqual({
    exact: false,
    streams: ["stream_1"],
    memoType: ["conversation"],
    knowledgeType: ["procedure"],
    tags: ["deploy"],
    scope: "workspace",
    limit: 5,
  })
  expect(textPayload(result)).toEqual({ data: [{ memo: { id: "memo_1" } }] })
})

test("search what=attachments posts to /attachments/search and maps content_types to `contentTypes`", async () => {
  fetchSpy.mockResolvedValue(jsonResponse(200, { data: [{ id: "att_1", filename: "plan.pdf" }] }))
  const client = await connectClient()

  const result = (await client.callTool({
    name: "search",
    arguments: {
      what: "attachments",
      query: "architecture diagram",
      stream_ids: ["stream_1"],
      content_types: ["diagram", "document"],
      limit: 10,
    },
  })) as CallToolResult
  expect(result.isError).toBeFalsy()

  expect(requestPath()).toBe("/api/v1/workspaces/ws_1/attachments/search")
  expect(requestBody(fetchSpy)).toEqual({
    query: "architecture diagram",
    streams: ["stream_1"],
    contentTypes: ["diagram", "document"],
    limit: 10,
  })
})

test("search rejects a filter the chosen what does not support before any HTTP call", async () => {
  const client = await connectClient()

  const result = (await client.callTool({
    name: "search",
    arguments: { what: "attachments", query: "x", memo_type: ["conversation"], type: ["channel"] },
  })) as CallToolResult

  expect(result.isError).toBe(true)
  const payload = textPayload(result)
  expect(payload.code).toBe("UNSUPPORTED_FILTER")
  expect(String(payload.message)).toContain("memo_type")
  expect(String(payload.message)).toContain("type")
  expect(String(payload.message)).toContain("content_types")
  expect(fetchSpy).not.toHaveBeenCalled()
})

test("search what=messages requires a non-empty query and does not call HTTP when missing", async () => {
  const client = await connectClient()

  const result = (await client.callTool({
    name: "search",
    arguments: { what: "messages" },
  })) as CallToolResult

  expect(result.isError).toBe(true)
  expect(textPayload(result).code).toBe("INVALID_ARGUMENT")
  expect(fetchSpy).not.toHaveBeenCalled()
})

test("search surfaces an API error as an isError result", async () => {
  fetchSpy.mockResolvedValue(jsonResponse(400, { error: "query too long", code: "VALIDATION_ERROR" }))
  const client = await connectClient()

  const result = (await client.callTool({
    name: "search",
    arguments: { what: "messages", query: "x" },
  })) as CallToolResult
  expect(result.isError).toBe(true)
  expect(textPayload(result).code).toBe("VALIDATION_ERROR")
})
