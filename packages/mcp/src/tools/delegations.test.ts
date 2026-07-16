import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { afterEach, expect, spyOn, test } from "bun:test"
import { connectClient, jsonResponse, requestBody, requestInit, textPayload } from "../test-support"

const fetchSpy = spyOn(globalThis, "fetch")

afterEach(() => {
  fetchSpy.mockReset()
})

function callbackHeader(index = 0): string | undefined {
  const headers = requestInit(fetchSpy, index).headers as Record<string, string> | undefined
  return headers?.["X-Threa-Callback-Token"]
}

test("list_delegations passes status and since as query params", async () => {
  fetchSpy.mockResolvedValue(jsonResponse(200, { data: [{ id: "dlg_1" }] }))
  const client = await connectClient()

  const result = (await client.callTool({
    name: "list_delegations",
    arguments: { status: "open", since: "2026-07-16T00:00:00.000Z" },
  })) as CallToolResult
  expect(result.isError).toBeFalsy()

  const url = new URL(String(fetchSpy.mock.calls[0]?.[0]))
  expect(url.pathname).toBe("/api/v1/workspaces/ws_1/delegations")
  expect(url.searchParams.get("status")).toBe("open")
  expect(url.searchParams.get("since")).toBe("2026-07-16T00:00:00.000Z")
  expect(textPayload(result)).toEqual({ data: [{ id: "dlg_1" }] })
})

test("claim_delegation maps body fields, stores the token, and returns it", async () => {
  fetchSpy.mockResolvedValue(
    jsonResponse(200, { data: { id: "dlg_1", brief: "do the thing", claimToken: "tok_secret" } })
  )
  const client = await connectClient()

  const result = (await client.callTool({
    name: "claim_delegation",
    arguments: { delegation_id: "dlg_1", claimed_by_label: "Kris's MacBook", idempotency_key: "idem-key-12345" },
  })) as CallToolResult
  expect(result.isError).toBeFalsy()

  const init = requestInit(fetchSpy)
  expect(init.method).toBe("POST")
  const url = new URL(String(fetchSpy.mock.calls[0]?.[0]))
  expect(url.pathname).toBe("/api/v1/workspaces/ws_1/delegations/dlg_1/claim")
  expect(requestBody(fetchSpy)).toEqual({ claimedByLabel: "Kris's MacBook", idempotencyKey: "idem-key-12345" })
  expect(textPayload(result)).toEqual({
    data: { id: "dlg_1", brief: "do the thing", claimToken: "tok_secret" },
  })
})

test("delegation_heartbeat sends the stored claim token in the callback header", async () => {
  fetchSpy.mockResolvedValue(jsonResponse(200, { data: { id: "dlg_1", claimToken: "tok_stored" } }))
  const client = await connectClient()

  await client.callTool({
    name: "claim_delegation",
    arguments: { delegation_id: "dlg_1", claimed_by_label: "runner" },
  })

  fetchSpy.mockResolvedValue(jsonResponse(200, { data: { claimExpiresAt: "2026-07-16T00:15:00.000Z" } }))
  const result = (await client.callTool({
    name: "delegation_heartbeat",
    arguments: { delegation_id: "dlg_1" },
  })) as CallToolResult
  expect(result.isError).toBeFalsy()

  const url = new URL(String(fetchSpy.mock.calls[1]?.[0]))
  expect(url.pathname).toBe("/api/v1/workspaces/ws_1/delegations/dlg_1/heartbeat")
  expect(callbackHeader(1)).toBe("tok_stored")
})

test("explicit claim_token overrides the stored token", async () => {
  fetchSpy.mockResolvedValue(jsonResponse(200, { data: { id: "dlg_1", claimToken: "tok_stored" } }))
  const client = await connectClient()

  await client.callTool({
    name: "claim_delegation",
    arguments: { delegation_id: "dlg_1", claimed_by_label: "runner" },
  })

  fetchSpy.mockResolvedValue(jsonResponse(200, { data: { id: "dlg_1" } }))
  await client.callTool({
    name: "report_delegation_status",
    arguments: { delegation_id: "dlg_1", status_note: "halfway", claim_token: "tok_explicit" },
  })

  const url = new URL(String(fetchSpy.mock.calls[1]?.[0]))
  expect(url.pathname).toBe("/api/v1/workspaces/ws_1/delegations/dlg_1/status")
  expect(requestBody(fetchSpy, 1)).toEqual({ statusNote: "halfway" })
  expect(callbackHeader(1)).toBe("tok_explicit")
})

test("a lifecycle tool with no stored or explicit token errors before any HTTP call", async () => {
  const client = await connectClient()

  const result = (await client.callTool({
    name: "delegation_heartbeat",
    arguments: { delegation_id: "dlg_unknown" },
  })) as CallToolResult

  expect(result.isError).toBe(true)
  expect(textPayload(result).code).toBe("MISSING_CLAIM_TOKEN")
  expect(fetchSpy).not.toHaveBeenCalled()
})

test("complete_delegation clears the stored token so a later call without one errors", async () => {
  fetchSpy.mockResolvedValue(jsonResponse(200, { data: { id: "dlg_1", claimToken: "tok_stored" } }))
  const client = await connectClient()

  await client.callTool({
    name: "claim_delegation",
    arguments: { delegation_id: "dlg_1", claimed_by_label: "runner" },
  })

  fetchSpy.mockResolvedValue(jsonResponse(200, { data: { id: "dlg_1", status: "completed" } }))
  const completed = (await client.callTool({
    name: "complete_delegation",
    arguments: { delegation_id: "dlg_1", result_markdown: "Shipped it." },
  })) as CallToolResult
  expect(completed.isError).toBeFalsy()
  expect(requestBody(fetchSpy, 1)).toEqual({ resultMarkdown: "Shipped it." })
  expect(callbackHeader(1)).toBe("tok_stored")

  const second = (await client.callTool({
    name: "complete_delegation",
    arguments: { delegation_id: "dlg_1", result_markdown: "again" },
  })) as CallToolResult
  expect(second.isError).toBe(true)
  expect(textPayload(second).code).toBe("MISSING_CLAIM_TOKEN")
  expect(fetchSpy.mock.calls.length).toBe(2)
})

test("claim_delegation surfaces a 409 lost race as an isError result", async () => {
  fetchSpy.mockResolvedValue(
    jsonResponse(409, { error: "Delegation is not open to claim", code: "DELEGATION_NOT_OPEN" })
  )
  const client = await connectClient()

  const result = (await client.callTool({
    name: "claim_delegation",
    arguments: { delegation_id: "dlg_1", claimed_by_label: "runner" },
  })) as CallToolResult

  expect(result.isError).toBe(true)
  expect(textPayload(result).code).toBe("DELEGATION_NOT_OPEN")
})
