import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { afterEach, expect, spyOn, test } from "bun:test"
import { connectClient, fetchByPath, jsonResponse, textPayload } from "../test-support"

const fetchSpy = spyOn(globalThis, "fetch")

afterEach(() => {
  fetchSpy.mockReset()
})

const STREAMS_LIST = "/api/v1/workspaces/ws_1/streams"
const DOCS = "/api/v1/workspaces/ws_1/docs"

function lastCall(): { method?: string; path: string; query: URLSearchParams; body: unknown } {
  const call = fetchSpy.mock.calls.at(-1)!
  const init = call[1] as RequestInit
  const url = new URL(String(call[0]))
  return {
    method: init.method,
    path: url.pathname,
    query: url.searchParams,
    body: init.body ? JSON.parse(String(init.body)) : undefined,
  }
}

test("list_docs resolves a #channel-slug and lists that stream's docs", async () => {
  fetchSpy.mockImplementation(
    fetchByPath((path) =>
      path === STREAMS_LIST
        ? jsonResponse(200, { data: [{ id: "stream_gen", slug: "general" }], hasMore: false })
        : jsonResponse(200, { data: [] })
    )
  )
  const client = await connectClient()

  const result = (await client.callTool({ name: "list_docs", arguments: { stream_id: "#general" } })) as CallToolResult
  expect(result.isError).toBeFalsy()

  const call = lastCall()
  expect({ method: call.method, path: call.path, streamId: call.query.get("streamId") }).toEqual({
    method: "GET",
    path: DOCS,
    streamId: "stream_gen",
  })
})

test("read_doc gets the doc by id", async () => {
  const doc = { id: "stream_d1", hostStreamId: "stream_1", title: "Plan", seq: 1, markdown: "<!-- blk_1 -->\nhi" }
  fetchSpy.mockResolvedValue(jsonResponse(200, { data: doc }))
  const client = await connectClient()

  const result = (await client.callTool({ name: "read_doc", arguments: { doc_id: "stream_d1" } })) as CallToolResult
  expect(result.isError).toBeFalsy()
  expect({ method: lastCall().method, path: lastCall().path }).toEqual({ method: "GET", path: `${DOCS}/stream_d1` })
  expect(textPayload(result)).toEqual({ data: doc })
})

test("edit_doc maps block_id to blockId and posts every edit together", async () => {
  fetchSpy.mockResolvedValue(jsonResponse(200, { data: { id: "stream_d1", seq: 2, touchedBlockIds: ["blk_1"] } }))
  const client = await connectClient()

  const result = (await client.callTool({
    name: "edit_doc",
    arguments: {
      doc_id: "stream_d1",
      reason: "fix typos",
      edits: [
        { block_id: "blk_1", old: "a", new: "b" },
        { old: "c", new: "d" },
      ],
    },
  })) as CallToolResult
  expect(result.isError).toBeFalsy()

  const call = lastCall()
  expect({ method: call.method, path: call.path, body: call.body }).toEqual({
    method: "POST",
    path: `${DOCS}/stream_d1/edits`,
    body: {
      reason: "fix typos",
      edits: [
        { blockId: "blk_1", old: "a", new: "b" },
        { old: "c", new: "d" },
      ],
    },
  })
})

test("create_doc resolves the stream and posts title, markdown, and reason", async () => {
  fetchSpy.mockResolvedValue(jsonResponse(201, { data: { id: "doc_9" } }))
  const client = await connectClient()

  const result = (await client.callTool({
    name: "create_doc",
    arguments: { stream_id: "stream_1", title: "Notes", markdown: "# Notes", reason: "start notes" },
  })) as CallToolResult
  expect(result.isError).toBeFalsy()

  const call = lastCall()
  expect({ method: call.method, path: call.path, body: call.body }).toEqual({
    method: "POST",
    path: DOCS,
    body: { streamId: "stream_1", title: "Notes", markdown: "# Notes", reason: "start notes" },
  })
})

test("comment_on_doc posts the content to the block's comments with a generated client message id", async () => {
  const response = { data: { threadId: "stream_t1", message: { id: "msg_1", content: "Looks good" } } }
  fetchSpy.mockResolvedValue(jsonResponse(201, response))
  const client = await connectClient()

  const result = (await client.callTool({
    name: "comment_on_doc",
    arguments: { doc_id: "stream_d1", block_id: "blk_1", content: "Looks good" },
  })) as CallToolResult
  expect(result.isError).toBeFalsy()

  const call = lastCall()
  expect({ method: call.method, path: call.path, body: call.body, payload: textPayload(result) }).toEqual({
    method: "POST",
    path: `${DOCS}/stream_d1/sections/blk_1/comments`,
    body: { content: "Looks good", clientMessageId: expect.stringMatching(/^mcp-/) },
    payload: {
      ...response,
      clientMessageId: (call.body as { clientMessageId: string }).clientMessageId,
    },
  })
})
