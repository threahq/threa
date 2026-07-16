import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { afterEach, expect, spyOn, test } from "bun:test"
import { connectClient, jsonResponse, requestBody, requestInit, textPayload } from "../test-support"

const fetchSpy = spyOn(globalThis, "fetch")

afterEach(() => {
  fetchSpy.mockReset()
})

test("search_memos maps snake_case filters to the wire body field names", async () => {
  fetchSpy.mockResolvedValue(jsonResponse(200, { data: [{ memo: { id: "memo_1" } }] }))
  const client = await connectClient()

  const result = (await client.callTool({
    name: "search_memos",
    arguments: {
      query: "deploy runbook",
      exact: false,
      stream_ids: ["stream_1"],
      memo_type: ["conversation"],
      knowledge_type: ["procedure"],
      tags: ["deploy"],
      scope: "workspace",
      limit: 5,
    },
  })) as CallToolResult
  expect(result.isError).toBeFalsy()

  const init = requestInit(fetchSpy)
  expect(init.method).toBe("POST")
  const url = new URL(String(fetchSpy.mock.calls[0]?.[0]))
  expect(url.pathname).toBe("/api/v1/workspaces/ws_1/memos/search")
  expect(requestBody(fetchSpy)).toEqual({
    query: "deploy runbook",
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

test("get_memo requests the memo detail path and passes the envelope through", async () => {
  fetchSpy.mockResolvedValue(jsonResponse(200, { data: { memo: { id: "memo_1" }, sourceMessages: [] } }))
  const client = await connectClient()

  const result = (await client.callTool({
    name: "get_memo",
    arguments: { memo_id: "memo_1" },
  })) as CallToolResult
  expect(result.isError).toBeFalsy()

  const init = requestInit(fetchSpy)
  expect(init.method).toBe("GET")
  const url = new URL(String(fetchSpy.mock.calls[0]?.[0]))
  expect(url.pathname).toBe("/api/v1/workspaces/ws_1/memos/memo_1")
  expect(textPayload(result)).toEqual({ data: { memo: { id: "memo_1" }, sourceMessages: [] } })
})

test("get_memo surfaces a 404 as an isError result with the scope hint", async () => {
  fetchSpy.mockResolvedValue(jsonResponse(404, { error: "Memo not found", code: "NOT_FOUND" }))
  const client = await connectClient()

  const result = (await client.callTool({
    name: "get_memo",
    arguments: { memo_id: "memo_missing" },
  })) as CallToolResult
  expect(result.isError).toBe(true)
  expect(textPayload(result).code).toBe("NOT_FOUND")
})
