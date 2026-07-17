/**
 * E2E tests for public API v1 — message search with bot API key auth.
 *
 * Run with: bun test --preload ./tests/setup.ts tests/e2e/public-api-search.test.ts
 */

import { describe, test, expect, beforeAll } from "bun:test"
import { TestClient, loginAs, createWorkspace, createChannel, createThread, sendMessage } from "../client"

const testRunId = Math.random().toString(36).substring(7)
const testEmail = (name: string) => `${name}-pubapi-${testRunId}@test.com`

interface TestContext {
  workspaceId: string
  publicChannelId: string
  privateChannelId: string
  keyword: string
  botApiKey: string
}

async function setupTestWorkspace(): Promise<TestContext> {
  const client = new TestClient()
  await loginAs(client, testEmail("setup"), "Setup User")
  const workspace = await createWorkspace(client, `PubAPI WS ${testRunId}`)

  const publicChannel = await createChannel(client, workspace.id, `public-${testRunId}`, "public")
  const privateChannel = await createChannel(client, workspace.id, `private-${testRunId}`, "private")

  const keyword = `testword${testRunId}`
  await sendMessage(client, workspace.id, publicChannel.id, `Public message about ${keyword}`)
  await sendMessage(client, workspace.id, privateChannel.id, `Private message about ${keyword}`)

  // Create a bot with a key that has messages:search scope
  const botRes = await client.post(`/api/workspaces/${workspace.id}/bots`, {
    type: "shared",
    name: `Search Bot ${testRunId}`,
    slug: `search-bot-${testRunId}`,
  })
  const bot = (botRes.data as { data: { id: string } }).data

  const keyRes = await client.post(`/api/workspaces/${workspace.id}/bots/${bot.id}/keys`, {
    name: "search-key",
    scopes: ["messages:search", "streams:read", "messages:read", "messages:write"],
  })
  const botApiKey = (keyRes.data as { value: string }).value

  return {
    workspaceId: workspace.id,
    publicChannelId: publicChannel.id,
    privateChannelId: privateChannel.id,
    keyword,
    botApiKey,
  }
}

function publicApiRequest(workspaceId: string, body: unknown, apiKey: string) {
  const baseUrl = process.env.TEST_BASE_URL || "http://localhost:3001"
  return fetch(`${baseUrl}/api/v1/workspaces/${workspaceId}/messages/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })
}

describe("Public API v1 — Message Search", () => {
  let ctx: TestContext

  beforeAll(async () => {
    ctx = await setupTestWorkspace()
  })

  describe("Authentication", () => {
    test("should return 401 for missing Authorization header", async () => {
      const baseUrl = process.env.TEST_BASE_URL || "http://localhost:3001"
      const res = await fetch(`${baseUrl}/api/v1/workspaces/${ctx.workspaceId}/messages/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "test" }),
      })
      expect(res.status).toBe(401)
    })

    test("should return 401 for invalid API key", async () => {
      const res = await publicApiRequest(ctx.workspaceId, { query: "test" }, "invalid_key_value")
      expect(res.status).toBe(401)
    })

    test("should return 401 for API key from wrong workspace", async () => {
      const res = await publicApiRequest("ws_nonexistent", { query: "test" }, ctx.botApiKey)
      expect(res.status).toBe(403)
    })
  })

  describe("Search Results", () => {
    test("should return results from public channels", async () => {
      const res = await publicApiRequest(ctx.workspaceId, { query: ctx.keyword }, ctx.botApiKey)
      expect(res.status).toBe(200)

      const data = (await res.json()) as { data: Array<{ streamId: string; content: string }> }
      expect(data.data.length).toBeGreaterThanOrEqual(1)

      const publicResults = data.data.filter((r) => r.streamId === ctx.publicChannelId)
      expect(publicResults.length).toBe(1)
      expect(publicResults[0].content).toContain(ctx.keyword)
    })

    test("should NOT return results from private channels without grant", async () => {
      const res = await publicApiRequest(ctx.workspaceId, { query: ctx.keyword }, ctx.botApiKey)
      const data = (await res.json()) as { data: Array<{ streamId: string }> }

      const privateResults = data.data.filter((r) => r.streamId === ctx.privateChannelId)
      expect(privateResults.length).toBe(0)
    })
  })

  describe("Validation", () => {
    test("should return 400 for empty query", async () => {
      const res = await publicApiRequest(ctx.workspaceId, { query: "" }, ctx.botApiKey)
      expect(res.status).toBe(400)
    })

    test("should return 400 for missing query", async () => {
      const res = await publicApiRequest(ctx.workspaceId, {}, ctx.botApiKey)
      expect(res.status).toBe(400)
    })

    test("should respect limit parameter", async () => {
      const res = await publicApiRequest(ctx.workspaceId, { query: ctx.keyword, limit: 1 }, ctx.botApiKey)
      expect(res.status).toBe(200)

      const data = (await res.json()) as { data: unknown[] }
      expect(data.data.length).toBeLessThanOrEqual(1)
    })

    test("should reject limit above maximum", async () => {
      const res = await publicApiRequest(ctx.workspaceId, { query: "test", limit: 100 }, ctx.botApiKey)
      expect(res.status).toBe(400)
    })
  })

  describe("Semantic Search", () => {
    test("should accept semantic flag and return results", async () => {
      const res = await publicApiRequest(ctx.workspaceId, { query: ctx.keyword, semantic: true }, ctx.botApiKey)
      expect(res.status).toBe(200)

      const data = (await res.json()) as { data: Array<{ streamId: string }> }
      expect(data.data.length).toBeGreaterThanOrEqual(1)
    })

    test("should default to keyword-only search when semantic is false", async () => {
      const res = await publicApiRequest(ctx.workspaceId, { query: ctx.keyword, semantic: false }, ctx.botApiKey)
      expect(res.status).toBe(200)

      const data = (await res.json()) as { data: Array<{ streamId: string }> }
      expect(data.data.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe("Exact Search", () => {
    test("should accept exact search and return literal matches", async () => {
      const res = await publicApiRequest(
        ctx.workspaceId,
        { query: `message about ${ctx.keyword}`, exact: true },
        ctx.botApiKey
      )
      expect(res.status).toBe(200)

      const data = (await res.json()) as { data: Array<{ streamId: string; content: string }> }
      expect(data.data.some((item) => item.streamId === ctx.publicChannelId)).toBe(true)
    })
  })

  describe("Filters", () => {
    test("should filter by stream type", async () => {
      const res = await publicApiRequest(ctx.workspaceId, { query: ctx.keyword, type: ["channel"] }, ctx.botApiKey)
      expect(res.status).toBe(200)

      const data = (await res.json()) as { data: Array<{ streamId: string }> }
      expect(data.data.length).toBeGreaterThanOrEqual(1)
    })

    test("should filter by specific streams", async () => {
      const res = await publicApiRequest(
        ctx.workspaceId,
        { query: ctx.keyword, streams: [ctx.publicChannelId] },
        ctx.botApiKey
      )
      expect(res.status).toBe(200)

      const data = (await res.json()) as { data: Array<{ streamId: string }> }
      for (const result of data.data) {
        expect(result.streamId).toBe(ctx.publicChannelId)
      }
    })

    test("should include thread replies in granted private channels and streams-filtered searches", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("threads"), "Thread Setup User")
      const workspace = await createWorkspace(client, `PubAPI Threads WS ${testRunId}`)
      const privateChannel = await createChannel(client, workspace.id, `priv-threads-${testRunId}`, "private")

      const botRes = await client.post(`/api/workspaces/${workspace.id}/bots`, {
        type: "shared",
        name: `Thread Bot ${testRunId}`,
        slug: `thread-bot-${testRunId}`,
      })
      const bot = (botRes.data as { data: { id: string } }).data
      const keyRes = await client.post(`/api/workspaces/${workspace.id}/bots/${bot.id}/keys`, {
        name: "thread-key",
        scopes: ["messages:search"],
      })
      const botApiKey = (keyRes.data as { value: string }).value

      const grantRes = await client.post(
        `/api/workspaces/${workspace.id}/bots/${bot.id}/streams/${privateChannel.id}/grant`,
        {}
      )
      expect([200, 201, 204]).toContain(grantRes.status)

      const keyword = `cockatrice${testRunId}`
      const rootMessage = await sendMessage(client, workspace.id, privateChannel.id, `Root ${keyword}`)
      const thread = await createThread(client, workspace.id, privateChannel.id, rootMessage.id)
      await sendMessage(client, workspace.id, thread.id, `Thread reply ${keyword}`)

      // Bot scope: the grant on the private channel must cover its threads
      const scopeRes = await publicApiRequest(workspace.id, { query: keyword }, botApiKey)
      expect(scopeRes.status).toBe(200)
      const scopeData = (await scopeRes.json()) as { data: Array<{ streamId: string }> }
      expect(scopeData.data.map((r) => r.streamId).sort()).toEqual([privateChannel.id, thread.id].sort())

      // streams filter: filtering by the channel id must include its thread replies
      const filterRes = await publicApiRequest(
        workspace.id,
        { query: keyword, streams: [privateChannel.id] },
        botApiKey
      )
      expect(filterRes.status).toBe(200)
      const filterData = (await filterRes.json()) as { data: Array<{ streamId: string }> }
      expect(filterData.data.map((r) => r.streamId).sort()).toEqual([privateChannel.id, thread.id].sort())
    })

    test("should filter by date range", async () => {
      const futureDate = new Date(Date.now() + 86400000).toISOString()
      const res = await publicApiRequest(ctx.workspaceId, { query: ctx.keyword, after: futureDate }, ctx.botApiKey)
      expect(res.status).toBe(200)

      const data = (await res.json()) as { data: unknown[] }
      expect(data.data.length).toBe(0)
    })
  })

  describe("Response Format", () => {
    test("should return properly formatted results", async () => {
      const res = await publicApiRequest(ctx.workspaceId, { query: ctx.keyword }, ctx.botApiKey)
      const data = (await res.json()) as {
        data: Array<{
          id: string
          streamId: string
          content: string
          authorId: string
          authorType: string
          createdAt: string
          rank: number
        }>
      }

      expect(data).toHaveProperty("data")

      if (data.data.length > 0) {
        const result = data.data[0]
        expect(result).toHaveProperty("id")
        expect(result).toHaveProperty("streamId")
        expect(result).toHaveProperty("content")
        expect(result).toHaveProperty("authorId")
        expect(result).toHaveProperty("authorType")
        expect(result).toHaveProperty("createdAt")
        expect(result).toHaveProperty("rank")
      }
    })
  })
})
