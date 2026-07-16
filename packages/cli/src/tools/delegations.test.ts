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

function pathOf(index: number): string {
  return new URL(String(fetchSpy.mock.calls[index]?.[0])).pathname
}

async function claim(client: Awaited<ReturnType<typeof connectClient>>): Promise<void> {
  fetchSpy.mockResolvedValueOnce(jsonResponse(200, { data: { id: "dlg_1", claimToken: "tok_stored" } }))
  await client.callTool({
    name: "claim_delegation",
    arguments: { delegation_id: "dlg_1", claimed_by_label: "runner" },
  })
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

  expect(requestInit(fetchSpy).method).toBe("POST")
  expect(pathOf(0)).toBe("/api/v1/workspaces/ws_1/delegations/dlg_1/claim")
  expect(requestBody(fetchSpy)).toEqual({ claimedByLabel: "Kris's MacBook", idempotencyKey: "idem-key-12345" })
  expect(textPayload(result)).toEqual({
    data: { id: "dlg_1", brief: "do the thing", claimToken: "tok_secret" },
  })
})

test("update_delegation with a status_note posts to /status with the stored token in the callback header", async () => {
  const client = await connectClient()
  await claim(client)

  fetchSpy.mockResolvedValueOnce(jsonResponse(200, { data: { id: "dlg_1" } }))
  const result = (await client.callTool({
    name: "update_delegation",
    arguments: { delegation_id: "dlg_1", status_note: "halfway" },
  })) as CallToolResult
  expect(result.isError).toBeFalsy()

  expect(pathOf(1)).toBe("/api/v1/workspaces/ws_1/delegations/dlg_1/status")
  expect(requestBody(fetchSpy, 1)).toEqual({ statusNote: "halfway" })
  expect(callbackHeader(1)).toBe("tok_stored")
})

test("update_delegation without a status_note posts to /heartbeat with the token", async () => {
  const client = await connectClient()
  await claim(client)

  fetchSpy.mockResolvedValueOnce(jsonResponse(200, { data: { claimExpiresAt: "2026-07-16T00:15:00.000Z" } }))
  const result = (await client.callTool({
    name: "update_delegation",
    arguments: { delegation_id: "dlg_1" },
  })) as CallToolResult
  expect(result.isError).toBeFalsy()

  expect(pathOf(1)).toBe("/api/v1/workspaces/ws_1/delegations/dlg_1/heartbeat")
  expect(callbackHeader(1)).toBe("tok_stored")
})

test("update_delegation prefers an explicit claim_token over the stored one", async () => {
  const client = await connectClient()
  await claim(client)

  fetchSpy.mockResolvedValueOnce(jsonResponse(200, { data: { id: "dlg_1" } }))
  await client.callTool({
    name: "update_delegation",
    arguments: { delegation_id: "dlg_1", status_note: "halfway", claim_token: "tok_explicit" },
  })

  expect(pathOf(1)).toBe("/api/v1/workspaces/ws_1/delegations/dlg_1/status")
  expect(callbackHeader(1)).toBe("tok_explicit")
})

test("a lifecycle tool with no stored or explicit token errors before any HTTP call", async () => {
  const client = await connectClient()

  const result = (await client.callTool({
    name: "update_delegation",
    arguments: { delegation_id: "dlg_unknown" },
  })) as CallToolResult

  expect(result.isError).toBe(true)
  expect(textPayload(result).code).toBe("MISSING_CLAIM_TOKEN")
  expect(fetchSpy).not.toHaveBeenCalled()
})

test("finish_delegation complete posts to /complete, sends the token, and clears it so a later call errors", async () => {
  const client = await connectClient()
  await claim(client)

  fetchSpy.mockResolvedValueOnce(jsonResponse(200, { data: { id: "dlg_1", status: "completed" } }))
  const completed = (await client.callTool({
    name: "finish_delegation",
    arguments: { delegation_id: "dlg_1", outcome: "complete", result_markdown: "Shipped it." },
  })) as CallToolResult
  expect(completed.isError).toBeFalsy()

  expect(pathOf(1)).toBe("/api/v1/workspaces/ws_1/delegations/dlg_1/complete")
  expect(requestBody(fetchSpy, 1)).toEqual({ resultMarkdown: "Shipped it." })
  expect(callbackHeader(1)).toBe("tok_stored")

  const second = (await client.callTool({
    name: "finish_delegation",
    arguments: { delegation_id: "dlg_1", outcome: "complete", result_markdown: "again" },
  })) as CallToolResult
  expect(second.isError).toBe(true)
  expect(textPayload(second).code).toBe("MISSING_CLAIM_TOKEN")
  expect(fetchSpy.mock.calls.length).toBe(2)
})

test("finish_delegation fail posts errorMessage to /fail", async () => {
  const client = await connectClient()
  await claim(client)

  fetchSpy.mockResolvedValueOnce(jsonResponse(200, { data: { id: "dlg_1", status: "failed" } }))
  const result = (await client.callTool({
    name: "finish_delegation",
    arguments: { delegation_id: "dlg_1", outcome: "fail", error_message: "build broke" },
  })) as CallToolResult
  expect(result.isError).toBeFalsy()

  expect(pathOf(1)).toBe("/api/v1/workspaces/ws_1/delegations/dlg_1/fail")
  expect(requestBody(fetchSpy, 1)).toEqual({ errorMessage: "build broke" })
  expect(callbackHeader(1)).toBe("tok_stored")
})

test("finish_delegation fail without error_message errors before any HTTP call", async () => {
  const client = await connectClient()
  await claim(client)

  const result = (await client.callTool({
    name: "finish_delegation",
    arguments: { delegation_id: "dlg_1", outcome: "fail" },
  })) as CallToolResult

  expect(result.isError).toBe(true)
  expect(textPayload(result).code).toBe("INVALID_ARGUMENT")
  expect(fetchSpy.mock.calls.length).toBe(1)
})

test("finish_delegation fail rejects result_markdown and metadata, naming them", async () => {
  const client = await connectClient()
  await claim(client)

  const result = (await client.callTool({
    name: "finish_delegation",
    arguments: {
      delegation_id: "dlg_1",
      outcome: "fail",
      error_message: "broke",
      result_markdown: "done",
      metadata: { k: "v" },
    },
  })) as CallToolResult

  expect(result.isError).toBe(true)
  const payload = textPayload(result)
  expect(payload.code).toBe("INVALID_ARGUMENT")
  expect(String(payload.message)).toContain("result_markdown")
  expect(String(payload.message)).toContain("metadata")
  expect(fetchSpy.mock.calls.length).toBe(1)
})

test("finish_delegation complete rejects error_message", async () => {
  const client = await connectClient()
  await claim(client)

  const result = (await client.callTool({
    name: "finish_delegation",
    arguments: { delegation_id: "dlg_1", outcome: "complete", error_message: "nope" },
  })) as CallToolResult

  expect(result.isError).toBe(true)
  expect(textPayload(result).code).toBe("INVALID_ARGUMENT")
  expect(String(textPayload(result).message)).toContain("error_message")
  expect(fetchSpy.mock.calls.length).toBe(1)
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
