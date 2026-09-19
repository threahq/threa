/**
 * read_stream and send_message over MCP against an end-to-end-encrypted stream.
 * The agent's own tools have no key flags, so the key settings come from the
 * server's config — the file a runtime writes for the CLI it launches.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  base64ToBytes,
  generateStreamKey,
  openMessageAsString,
  parseSealedPayload,
  type StreamEnvelope,
} from "../../../../extensions/bot-runtime-client/src/crypto"
import type { ThreaConfig } from "../config"
import { connectorHostKey, sealedMessageRow, wrapStreamKey } from "../sealed-test-fixtures"
import { connectClient, jsonResponse, TEST_CONFIG, textPayload } from "../test-support"

const STREAM = "stream_01SEALEDMCP"
const GENERATION = 5

const fetchSpy = spyOn(globalThis, "fetch")
const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "threa-mcp-sealed-"))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  fetchSpy.mockReset()
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function botConfig(dir: string): ThreaConfig {
  return {
    ...TEST_CONFIG,
    apiKey: "threa_bk_secret",
    principal: "bot",
    keyScope: "host",
    keyStore: "file",
    keyDir: dir,
  }
}

function serve(routes: Record<string, () => Response>): { path: string; method: string; body: unknown }[] {
  const seen: { path: string; method: string; body: unknown }[] = []
  fetchSpy.mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname.replace("/api/v1/workspaces/ws_1", "")
    seen.push({
      path,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    })
    const route = routes[path]
    if (!route) throw new Error(`unexpected request to ${path}`)
    return route()
  }) as unknown as typeof fetch)
  return seen
}

const ME_BOT = () => jsonResponse(200, { data: { kind: "bot", botId: "bot_1" } })
const SEALED_STREAM = () =>
  jsonResponse(200, { data: { id: STREAM, type: "scratchpad", rootStreamId: null, e2eEnabled: true } })

test("read_stream opens the sealed page with the key named by the server's config", async () => {
  const dir = tempDir()
  const config = botConfig(dir)
  const recipient = await connectorHostKey({ dir, apiKey: config.apiKey })
  const streamKey = generateStreamKey()
  const wrap = await wrapStreamKey({ streamId: STREAM, keyGeneration: GENERATION, recipient, streamKey })
  const row = await sealedMessageRow({
    streamId: STREAM,
    messageId: "msg_1",
    senderId: "bot_1",
    keyGeneration: GENERATION,
    streamKey,
    contentMarkdown: "sealed notes for the agent",
    sequence: "11",
  })
  serve({
    "/me": ME_BOT,
    "/users": () => jsonResponse(200, { data: [], hasMore: false }),
    [`/streams/${STREAM}`]: SEALED_STREAM,
    [`/streams/${STREAM}/e2e/key-wraps`]: () =>
      jsonResponse(200, { data: { currentKeyGeneration: GENERATION, ownerUserId: "usr_1", wraps: [wrap] } }),
    [`/streams/${STREAM}/messages`]: () => jsonResponse(200, { data: [row], hasMore: false }),
  })

  const result = (await (
    await connectClient(config)
  ).callTool({
    name: "read_stream",
    arguments: { stream_id: STREAM },
  })) as CallToolResult

  expect(result.isError).toBeFalsy()
  const payload = textPayload(result) as { messages: { data: Record<string, unknown>[] } }
  expect(payload.messages.data[0]).toMatchObject({ id: "msg_1", content: "sealed notes for the agent" })
  expect(payload.messages.data[0]).not.toHaveProperty("sealed")
})

test("send_message seals the body before it leaves the server process", async () => {
  const dir = tempDir()
  const config = botConfig(dir)
  const recipient = await connectorHostKey({ dir, apiKey: config.apiKey })
  const streamKey = generateStreamKey()
  const wrap = await wrapStreamKey({ streamId: STREAM, keyGeneration: GENERATION, recipient, streamKey })
  const seen = serve({
    "/me": ME_BOT,
    [`/streams/${STREAM}`]: SEALED_STREAM,
    [`/streams/${STREAM}/e2e/key-wraps`]: () =>
      jsonResponse(200, { data: { currentKeyGeneration: GENERATION, ownerUserId: "usr_1", wraps: [wrap] } }),
    [`/streams/${STREAM}/messages`]: () => jsonResponse(201, { data: { id: "msg_new" } }),
  })

  const result = (await (
    await connectClient(config)
  ).callTool({
    name: "send_message",
    arguments: { stream_id: STREAM, content: "reply in the clear? no" },
  })) as CallToolResult

  expect(result.isError).toBeFalsy()
  expect(textPayload(result)).toMatchObject({ data: { id: "msg_new" }, sealed: true })
  const body = seen.find((call) => call.method === "POST")!.body as {
    content?: string
    sealed: { ciphertext: string; envelope: StreamEnvelope }
  }
  expect(JSON.stringify(body)).not.toContain("reply in the clear")
  const opened = await openMessageAsString({
    key: streamKey,
    ciphertext: base64ToBytes(body.sealed.ciphertext),
    envelope: body.sealed.envelope,
  })
  expect(parseSealedPayload(opened).contentMarkdown).toBe("reply in the clear? no")
})

test("send_message refuses metadata in a sealed stream instead of leaking it", async () => {
  const dir = tempDir()
  const config = botConfig(dir)
  await connectorHostKey({ dir, apiKey: config.apiKey })
  const seen = serve({ "/me": ME_BOT, [`/streams/${STREAM}`]: SEALED_STREAM })

  const result = (await (
    await connectClient(config)
  ).callTool({
    name: "send_message",
    arguments: { stream_id: STREAM, content: "hi", metadata: { "github.pr": "org/repo#1" } },
  })) as CallToolResult

  expect(result.isError).toBe(true)
  expect(textPayload(result).code).toBe("INVALID_ARGUMENT")
  expect(seen.some((call) => call.method === "POST")).toBe(false)
})
