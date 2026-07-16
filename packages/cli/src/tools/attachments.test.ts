import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { afterEach, expect, spyOn, test } from "bun:test"
import { connectClient, jsonResponse, requestInit, textPayload } from "../test-support"

const fetchSpy = spyOn(globalThis, "fetch")

afterEach(() => {
  fetchSpy.mockReset()
})

test("get_attachment requests the details path and passes the extraction envelope through", async () => {
  fetchSpy.mockResolvedValue(
    jsonResponse(200, { data: { id: "att_1", extraction: { summary: "s", fullText: "hello" } } })
  )
  const client = await connectClient()

  const result = (await client.callTool({
    name: "get_attachment",
    arguments: { attachment_id: "att_1" },
  })) as CallToolResult
  expect(result.isError).toBeFalsy()

  const init = requestInit(fetchSpy)
  expect(init.method).toBe("GET")
  const url = new URL(String(fetchSpy.mock.calls[0]?.[0]))
  expect(url.pathname).toBe("/api/v1/workspaces/ws_1/attachments/att_1")
  expect(textPayload(result)).toEqual({ data: { id: "att_1", extraction: { summary: "s", fullText: "hello" } } })
})

test("get_attachment_download_url requests the signed-url path", async () => {
  fetchSpy.mockResolvedValue(jsonResponse(200, { data: { url: "https://signed.example/x", expiresIn: 300 } }))
  const client = await connectClient()

  const result = (await client.callTool({
    name: "get_attachment_download_url",
    arguments: { attachment_id: "att_1" },
  })) as CallToolResult
  expect(result.isError).toBeFalsy()

  const init = requestInit(fetchSpy)
  expect(init.method).toBe("GET")
  const url = new URL(String(fetchSpy.mock.calls[0]?.[0]))
  expect(url.pathname).toBe("/api/v1/workspaces/ws_1/attachments/att_1/url")
  expect(textPayload(result)).toEqual({ data: { url: "https://signed.example/x", expiresIn: 300 } })
})
