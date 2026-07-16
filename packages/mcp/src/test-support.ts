import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { createThreaMcpServer } from "./server"
import type { ThreaMcpConfig } from "./config"

export const TEST_CONFIG: ThreaMcpConfig = {
  apiKey: "threa_uk_secret",
  workspaceId: "ws_1",
  baseUrl: "https://app.threa.io",
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

export async function connectClient(config: ThreaMcpConfig = TEST_CONFIG): Promise<Client> {
  const server = createThreaMcpServer(config)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "test", version: "0.0.0" })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

export function textPayload(result: CallToolResult): Record<string, unknown> {
  const first = result.content[0]
  if (first?.type !== "text") throw new Error("expected text content")
  return JSON.parse(first.text) as Record<string, unknown>
}

type FetchSpy = { mock: { calls: unknown[][] } }

export function requestInit(fetchSpy: FetchSpy, index = 0): RequestInit {
  return (fetchSpy.mock.calls[index]?.[1] ?? {}) as RequestInit
}

export function requestBody(fetchSpy: FetchSpy, index = 0): Record<string, unknown> {
  return JSON.parse(String(requestInit(fetchSpy, index).body)) as Record<string, unknown>
}
