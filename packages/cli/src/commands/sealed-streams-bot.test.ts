/**
 * The sealed read and send paths run as a bot rather than a person: the CLI a
 * runtime launches beside itself must address the key that runtime filed under
 * its configured scope, or it looks in the wrong account and reports a missing
 * key for a stream it was wrapped to.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test"
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
import { run } from "../cli"
import type { ThreaConfig } from "../config"
import { connectorHostKey, sealedMessageRow, wrapStreamKey } from "../sealed-test-fixtures"
import { jsonResponse, TEST_CONFIG } from "../test-support"

const STREAM = "stream_01SEALEDBOT"
const GENERATION = 2
const BOT_CONFIG: ThreaConfig = { ...TEST_CONFIG, apiKey: "threa_bk_secret", principal: "bot", keyScope: "host" }

const fetchSpy = spyOn(globalThis, "fetch")
const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "threa-cli-sealed-bot-"))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  fetchSpy.mockReset()
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

interface Captured {
  path: string
  method: string
  body: unknown
}

function serve(routes: Record<string, () => Response>): Captured[] {
  const seen: Captured[] = []
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
const NO_USERS = () => jsonResponse(200, { data: [], hasMore: false })
const SEALED_STREAM = () =>
  jsonResponse(200, { data: { id: STREAM, type: "scratchpad", rootStreamId: null, e2eEnabled: true } })

describe("a bot principal on a sealed stream", () => {
  test("reads with the key its runtime filed under the configured scope", async () => {
    const dir = tempDir()
    const recipient = await connectorHostKey({ dir, apiKey: BOT_CONFIG.apiKey })
    const streamKey = generateStreamKey()
    const wrap = await wrapStreamKey({ streamId: STREAM, keyGeneration: GENERATION, recipient, streamKey })
    const row = await sealedMessageRow({
      streamId: STREAM,
      messageId: "msg_1",
      senderId: "bot_1",
      keyGeneration: GENERATION,
      streamKey,
      contentMarkdown: "the runtime can read this",
      sequence: "3",
    })
    serve({
      "/me": ME_BOT,
      "/users": NO_USERS,
      [`/streams/${STREAM}`]: SEALED_STREAM,
      [`/streams/${STREAM}/e2e/key-wraps`]: () =>
        jsonResponse(200, { data: { currentKeyGeneration: GENERATION, ownerUserId: "usr_1", wraps: [wrap] } }),
      [`/streams/${STREAM}/messages`]: () => jsonResponse(200, { data: [row], hasMore: false }),
    })

    const result = await run(["streams", "read", STREAM, "--key-store", "file", "--key-dir", dir, "--json"], {
      config: BOT_CONFIG,
    })

    expect(result.exitCode).toBe(0)
    const payload = JSON.parse(result.stdout) as { messages: { data: Record<string, unknown>[] } }
    expect(payload.messages.data[0]).toMatchObject({ id: "msg_1", content: "the runtime can read this" })
  })

  test("seals what it sends to the bot's own id", async () => {
    const dir = tempDir()
    const recipient = await connectorHostKey({ dir, apiKey: BOT_CONFIG.apiKey })
    const streamKey = generateStreamKey()
    const wrap = await wrapStreamKey({ streamId: STREAM, keyGeneration: GENERATION, recipient, streamKey })
    const seen = serve({
      "/me": ME_BOT,
      [`/streams/${STREAM}`]: SEALED_STREAM,
      [`/streams/${STREAM}/e2e/key-wraps`]: () =>
        jsonResponse(200, { data: { currentKeyGeneration: GENERATION, ownerUserId: "usr_1", wraps: [wrap] } }),
      [`/streams/${STREAM}/messages`]: () => jsonResponse(201, { data: { id: "msg_new" } }),
    })

    const result = await run(["messages", "send", STREAM, "on it", "--key-store", "file", "--key-dir", dir, "--json"], {
      config: BOT_CONFIG,
    })

    expect(result.exitCode).toBe(0)
    const body = seen.find((call) => call.method === "POST")!.body as {
      content?: string
      sealed: { ciphertext: string; envelope: StreamEnvelope }
    }
    expect(JSON.stringify(body)).not.toContain("on it")
    const opened = await openMessageAsString({
      key: streamKey,
      ciphertext: base64ToBytes(body.sealed.ciphertext),
      envelope: body.sealed.envelope,
    })
    expect({
      content: parseSealedPayload(opened).contentMarkdown,
      sender: new TextDecoder().decode(base64ToBytes(body.sealed.envelope.aad)).split("|")[2],
    }).toEqual({ content: "on it", sender: "bot_1" })
  })

  test("names the scope it looked under when this machine holds no bot key", async () => {
    const dir = tempDir()
    serve({
      "/me": ME_BOT,
      "/users": NO_USERS,
      [`/streams/${STREAM}`]: SEALED_STREAM,
      [`/streams/${STREAM}/messages`]: () =>
        jsonResponse(200, {
          data: [
            {
              id: "msg_1",
              sequence: "3",
              authorId: "bot_1",
              authorType: "bot",
              createdAt: "2026-09-19T09:00:00.000Z",
              content: "​",
              sealed: { ciphertext: "AAAA", envelope: { v: 2, keyGeneration: 1, iv: "aXY=", aad: "YWFk" } },
            },
          ],
          hasMore: false,
        }),
    })

    const result = await run(["streams", "read", STREAM, "--key-store", "file", "--key-dir", dir], {
      config: BOT_CONFIG,
    })

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("set keyScope to the one it uses")
    expect(result.stderr).not.toContain("threa e2e unlock")
  })
})
