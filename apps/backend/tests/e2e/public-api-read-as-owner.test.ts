/**
 * E2E — a personal bot with `readsAsOwner` reads through the public API
 * wherever its owner can read, but still cannot write anywhere it hasn't been
 * added: reads widen, participation stays consent-gated.
 *
 * Run with: bun test --preload ./tests/setup.ts tests/e2e/public-api-read-as-owner.test.ts
 */

import { describe, test, expect, beforeAll } from "bun:test"
import {
  TestClient,
  loginAs,
  createWorkspace,
  createChannel,
  createThread,
  sendMessage,
  createBot,
  createBotKey,
  botApiGet,
  botApiPost,
} from "../client"

const testRunId = Math.random().toString(36).substring(7)

const BOT_SCOPES = ["messages:read", "messages:search", "messages:write", "streams:read"]

interface Ctx {
  client: TestClient
  workspaceId: string
  publicChannelId: string
  privateChannelId: string
  privateThreadId: string
  keyword: string
  readerKey: string
  plainKey: string
}

let ctx: Ctx

beforeAll(async () => {
  const client = new TestClient()
  await loginAs(client, `owner-rao-${testRunId}@test.com`, "Read As Owner")
  const workspace = await createWorkspace(client, `RAO WS ${testRunId}`)

  const publicChannel = await createChannel(client, workspace.id, `general-${testRunId}`, "public")
  const privateChannel = await createChannel(client, workspace.id, `secret-${testRunId}`, "private")

  const keyword = `raoword${testRunId}`
  await sendMessage(client, workspace.id, publicChannel.id, `public ${keyword}`)
  const anchor = await sendMessage(client, workspace.id, privateChannel.id, `private ${keyword}`)
  const thread = await createThread(client, workspace.id, privateChannel.id, anchor.id)
  await sendMessage(client, workspace.id, thread.id, `thread ${keyword}`)

  // Neither bot is granted any stream; the only difference is the setting.
  const readerBot = await createBot(client, workspace.id, {
    type: "personal",
    name: `Reader ${testRunId}`,
    slug: `reader-${testRunId}`,
    readsAsOwner: true,
  })
  const plainBot = await createBot(client, workspace.id, {
    type: "personal",
    name: `Plain ${testRunId}`,
    slug: `plain-${testRunId}`,
  })

  ctx = {
    client,
    workspaceId: workspace.id,
    publicChannelId: publicChannel.id,
    privateChannelId: privateChannel.id,
    privateThreadId: thread.id,
    keyword,
    readerKey: await createBotKey(client, workspace.id, readerBot.id, BOT_SCOPES),
    plainKey: await createBotKey(client, workspace.id, plainBot.id, BOT_SCOPES),
  }
})

describe("read-as-owner over the public API", () => {
  test("should list the owner's private channel and read its messages, thread included", async () => {
    const streams = await botApiGet<{ data: { id: string }[] }>(ctx.client, ctx.workspaceId, "/streams", ctx.readerKey)
    expect(streams.status).toBe(200)
    expect(streams.data.data.map((stream) => stream.id)).toContain(ctx.privateChannelId)

    const messages = await botApiGet<{ data: { content: string }[] }>(
      ctx.client,
      ctx.workspaceId,
      `/streams/${ctx.privateChannelId}/messages`,
      ctx.readerKey
    )
    expect(messages.status).toBe(200)
    expect(messages.data.data.some((message) => message.content.includes(ctx.keyword))).toBe(true)

    const threadMessages = await botApiGet<{ data: { content: string }[] }>(
      ctx.client,
      ctx.workspaceId,
      `/streams/${ctx.privateThreadId}/messages`,
      ctx.readerKey
    )
    expect(threadMessages.status).toBe(200)
    expect(threadMessages.data.data.some((message) => message.content.includes(`thread ${ctx.keyword}`))).toBe(true)
  })

  test("should surface private results in search with the setting on, public-only with it off", async () => {
    const readerSearch = await botApiPost<{ data: { streamId: string }[] }>(
      ctx.client,
      ctx.workspaceId,
      "/messages/search",
      ctx.readerKey,
      { query: ctx.keyword }
    )
    expect(readerSearch.status).toBe(200)
    const readerStreamIds = readerSearch.data.data.map((result) => result.streamId)
    expect(readerStreamIds).toContain(ctx.privateChannelId)
    expect(readerStreamIds).toContain(ctx.publicChannelId)

    const plainSearch = await botApiPost<{ data: { streamId: string }[] }>(
      ctx.client,
      ctx.workspaceId,
      "/messages/search",
      ctx.plainKey,
      { query: ctx.keyword }
    )
    expect(plainSearch.status).toBe(200)
    const plainStreamIds = plainSearch.data.data.map((result) => result.streamId)
    expect(plainStreamIds).not.toContain(ctx.privateChannelId)
    expect(plainStreamIds).toContain(ctx.publicChannelId)
  })

  test("should deny the flag-off bot the private channel entirely", async () => {
    const denied = await botApiGet(
      ctx.client,
      ctx.workspaceId,
      `/streams/${ctx.privateChannelId}/messages`,
      ctx.plainKey
    )
    expect(denied.status).toBe(403)
  })

  test("should still refuse writes everywhere the bot is not added — read widens, participation does not", async () => {
    // A stream the bot can read fails writes with the truthful terminal 403
    // READ_ONLY; existence hiding (404) is kept for streams it cannot read.
    const privateAttempt = await botApiPost<{ code: string }>(
      ctx.client,
      ctx.workspaceId,
      `/streams/${ctx.privateChannelId}/messages`,
      ctx.readerKey,
      { content: "bot trying to post" }
    )
    expect(privateAttempt.status).toBe(403)
    expect(privateAttempt.data.code).toBe("STREAM_READ_ONLY")

    const publicAttempt = await botApiPost(
      ctx.client,
      ctx.workspaceId,
      `/streams/${ctx.publicChannelId}/messages`,
      ctx.readerKey,
      { content: "bot trying to post" }
    )
    expect(publicAttempt.status).toBe(403)
  })

  test("should read the public channel with either key", async () => {
    for (const key of [ctx.readerKey, ctx.plainKey]) {
      const messages = await botApiGet(ctx.client, ctx.workspaceId, `/streams/${ctx.publicChannelId}/messages`, key)
      expect(messages.status).toBe(200)
    }
  })
})
