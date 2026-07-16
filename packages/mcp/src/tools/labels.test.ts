import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { afterEach, expect, spyOn, test } from "bun:test"
import { connectClient, jsonResponse, requestBody, requestInit, textPayload } from "../test-support"

const fetchSpy = spyOn(globalThis, "fetch")

afterEach(() => {
  fetchSpy.mockReset()
})

test("list_labels reads the label catalog", async () => {
  fetchSpy.mockResolvedValue(jsonResponse(200, { data: { labels: [], assignments: [] } }))
  const client = await connectClient()

  const result = (await client.callTool({ name: "list_labels", arguments: {} })) as CallToolResult
  expect(result.isError).toBeFalsy()

  const url = new URL(String(fetchSpy.mock.calls[0]?.[0]))
  expect(requestInit(fetchSpy).method).toBe("GET")
  expect(url.pathname).toBe("/api/v1/workspaces/ws_1/labels")
  expect(textPayload(result)).toEqual({ data: { labels: [], assignments: [] } })
})

test("apply_label posts a stream assignment by name with appearance fields", async () => {
  fetchSpy.mockResolvedValue(jsonResponse(201, { data: { label: { id: "lbl_1", name: "urgent" } } }))
  const client = await connectClient()

  const result = (await client.callTool({
    name: "apply_label",
    arguments: { name: "urgent", stream_id: "stream_1", color: "#ff0000", emoji: "🔥" },
  })) as CallToolResult
  expect(result.isError).toBeFalsy()

  const init = requestInit(fetchSpy)
  expect(init.method).toBe("POST")
  const url = new URL(String(fetchSpy.mock.calls[0]?.[0]))
  expect(url.pathname).toBe("/api/v1/workspaces/ws_1/labels/assignments")
  expect(requestBody(fetchSpy)).toEqual({
    name: "urgent",
    color: "#ff0000",
    emoji: "🔥",
    resourceType: "stream",
    resourceId: "stream_1",
  })
})

test("remove_label deletes the assignment via query params and handles the 204 response", async () => {
  fetchSpy.mockResolvedValue(new Response(null, { status: 204 }))
  const client = await connectClient()

  const result = (await client.callTool({
    name: "remove_label",
    arguments: { name: "urgent", stream_id: "stream_1" },
  })) as CallToolResult
  expect(result.isError).toBeFalsy()

  const init = requestInit(fetchSpy)
  expect(init.method).toBe("DELETE")
  const url = new URL(String(fetchSpy.mock.calls[0]?.[0]))
  expect(url.pathname).toBe("/api/v1/workspaces/ws_1/labels/assignments")
  expect(url.searchParams.get("name")).toBe("urgent")
  expect(url.searchParams.get("resourceType")).toBe("stream")
  expect(url.searchParams.get("resourceId")).toBe("stream_1")
  expect(textPayload(result)).toEqual({ removed: true, name: "urgent", stream_id: "stream_1" })
})
