import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { afterEach, expect, spyOn, test } from "bun:test"
import { connectClient, jsonResponse, textPayload } from "../test-support"

const fetchSpy = spyOn(globalThis, "fetch")

afterEach(() => {
  fetchSpy.mockReset()
})

test("list_users maps args to the wire query and passes the list envelope through incl. cursor", async () => {
  fetchSpy.mockResolvedValue(jsonResponse(200, { data: [{ id: "usr_1" }], hasMore: true, cursor: "cur_2" }))
  const client = await connectClient()

  const tools = await client.listTools()
  expect(tools.tools.map((t) => t.name)).toContain("list_users")

  const result = (await client.callTool({
    name: "list_users",
    arguments: { query: "kris", after: "cur_1", limit: 20 },
  })) as CallToolResult
  expect(result.isError).toBeFalsy()

  const url = new URL(String(fetchSpy.mock.calls[0]?.[0]))
  expect(url.pathname).toBe("/api/v1/workspaces/ws_1/users")
  expect(url.searchParams.get("query")).toBe("kris")
  expect(url.searchParams.get("after")).toBe("cur_1")
  expect(url.searchParams.get("limit")).toBe("20")

  expect(textPayload(result)).toEqual({ data: [{ id: "usr_1" }], hasMore: true, cursor: "cur_2" })
})
