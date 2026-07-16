import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { afterEach, expect, spyOn, test } from "bun:test"
import { connectClient, jsonResponse, textPayload } from "../test-support"

const fetchSpy = spyOn(globalThis, "fetch")

afterEach(() => {
  fetchSpy.mockReset()
})

test("whoami is listed and round-trips the /me principal with binding info", async () => {
  fetchSpy.mockResolvedValue(
    jsonResponse(200, {
      data: {
        kind: "user",
        workspaceId: "ws_1",
        userId: "usr_1",
        apiVersion: { pinned: null, resolved: "2026-07-01", current: "2026-07-01", supported: ["2026-07-01"] },
      },
    })
  )
  const client = await connectClient()

  const tools = await client.listTools()
  expect(tools.tools.map((t) => t.name)).toContain("whoami")

  const result = (await client.callTool({ name: "whoami", arguments: {} })) as CallToolResult
  expect(result.isError).toBeFalsy()
  const payload = textPayload(result)
  const principal = payload.principal as { kind: string; apiVersion?: unknown }
  expect(principal.kind).toBe("user")
  expect(principal.apiVersion).toBeDefined()
  expect(payload.baseUrl).toBe("https://app.threa.io")
  expect(payload.workspaceId).toBe("ws_1")
})

test("whoami surfaces an API error as an isError result carrying the scope hint", async () => {
  fetchSpy.mockResolvedValue(jsonResponse(404, { error: { code: "NOT_FOUND", message: "gone" } }))
  const client = await connectClient()

  const result = (await client.callTool({ name: "whoami", arguments: {} })) as CallToolResult
  expect(result.isError).toBe(true)
  const payload = textPayload(result)
  expect(payload.code).toBe("NOT_FOUND")
  expect(payload.hint).toMatch(/scope/i)
})
