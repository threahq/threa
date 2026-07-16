/**
 * E2E tests for public API v1 — conversation endpoints and the sendMessage
 * conversation directive.
 *
 * Run with: bun test --preload ./tests/setup.ts tests/e2e/public-api-conversations.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import type { Pool } from "pg"
import { TestClient, loginAs, createWorkspace, createChannel, createThread, createBot, createBotKey } from "../client"
import { createTestPool } from "../integration/setup"

const testRunId = Math.random().toString(36).substring(7)
const testEmail = (name: string) => `${name}-conv-${testRunId}@test.com`

interface WireConversation {
  id: string
  streamId: string
  rootStreamId: string
  topicSummary: string | null
  summary: string | null
  status: string
  messageCount: number
  participantIds: string[]
  lastActivityAt: string
  createdAt: string
  updatedAt: string
}

interface WireMessage {
  id: string
  streamId: string
  content: string
  createdAt: string
}

interface TestContext {
  client: TestClient
  workspaceId: string
  publicChannelId: string
  secondPublicChannelId: string
  privateChannelId: string
  threadStreamId: string
  /** Conversation seeded in the public channel via the public API directive. */
  publicConversationId: string
  /** Conversation seeded in the second public channel. */
  secondConversationId: string
  /** Conversation seeded in the private channel (internal API, user is member). */
  privateConversationId: string
  /** Conversation anchored in a thread under the public channel. */
  threadConversationId: string
  botReadWriteKey: string
  streamsReadOnlyKey: string
  userKey: string
}

const baseUrl = () => process.env.TEST_BASE_URL || "http://localhost:3001"

function apiGet(path: string, apiKey: string) {
  return fetch(`${baseUrl()}${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
  })
}

function apiPost(path: string, body: unknown, apiKey: string) {
  return fetch(`${baseUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  })
}

async function sendViaPublicApi(
  ctx: Pick<TestContext, "workspaceId" | "botReadWriteKey">,
  streamId: string,
  content: string,
  conversation?: { intent: "new" } | { intent: "existing"; conversationId: string }
): Promise<{ status: number; body: { data?: { id: string }; conversationId?: string; code?: string } }> {
  const res = await apiPost(
    `/api/v1/workspaces/${ctx.workspaceId}/streams/${streamId}/messages`,
    { content, ...(conversation && { conversation }) },
    ctx.botReadWriteKey
  )
  return { status: res.status, body: (await res.json()) as never }
}

let pool: Pool

async function setupTestWorkspace(): Promise<TestContext> {
  const client = new TestClient()
  const workosUser = await loginAs(client, testEmail("setup"), `ConvUser ${testRunId}`)
  const workspace = await createWorkspace(client, `Conv WS ${testRunId}`)

  // User-key auth clamps scopes against the owner's live workspace permissions.
  // The e2e harness has no control-plane, so seed the owner's mirror row —
  // without it every user-key request 401s OWNER_INACTIVE.
  await pool.query(
    `INSERT INTO workspace_user_permissions (workspace_id, workos_user_id, role_slugs, status, last_event_at)
     VALUES ($1, $2, '{owner}', 'active', now()) ON CONFLICT DO NOTHING`,
    [workspace.id, workosUser.id]
  )

  const publicChannel = await createChannel(client, workspace.id, `pub-conv-${testRunId}`, "public")
  const secondPublicChannel = await createChannel(client, workspace.id, `pub2-conv-${testRunId}`, "public")
  const privateChannel = await createChannel(client, workspace.id, `priv-conv-${testRunId}`, "private")

  const botRes = await createBot(client, workspace.id, {
    type: "shared",
    name: `Conv Bot ${testRunId}`,
    slug: `conv-bot-${testRunId}`,
  })
  const botReadWriteKey = await createBotKey(client, workspace.id, botRes.id, ["messages:read", "messages:write"], "rw")
  const streamsReadOnlyKey = await createBotKey(client, workspace.id, botRes.id, ["streams:read"], "streams-only")

  const userKeyRes = await client.post<{ key: { id: string }; value: string }>(
    `/api/workspaces/${workspace.id}/user-api-keys`,
    { name: `conv-user-${testRunId}`, scopes: ["messages:read", "messages:write"] }
  )
  if (userKeyRes.status !== 201) {
    throw new Error(`Create user key failed (${userKeyRes.status}): ${JSON.stringify(userKeyRes.data)}`)
  }
  const userKey = (userKeyRes.data as { value: string }).value

  const partial = { workspaceId: workspace.id, botReadWriteKey }

  // Seed the public-channel conversation through the public API itself.
  const seeded = await sendViaPublicApi(partial, publicChannel.id, `opening post ${testRunId}`, { intent: "new" })
  if (seeded.status !== 201 || !seeded.body.conversationId) {
    throw new Error(`Seeding public conversation failed: ${JSON.stringify(seeded.body)}`)
  }

  const seededSecond = await sendViaPublicApi(partial, secondPublicChannel.id, `other channel post ${testRunId}`, {
    intent: "new",
  })
  if (!seededSecond.body.conversationId) throw new Error("Seeding second conversation failed")

  // Private conversation via the internal API (the logged-in user is a member).
  const privRes = await client.post<{ message: { id: string }; conversationId?: string }>(
    `/api/workspaces/${workspace.id}/messages`,
    { streamId: privateChannel.id, content: `private post ${testRunId}`, conversation: { intent: "new" } }
  )
  const privBody = privRes.data as { message: { id: string }; conversationId?: string }
  if (!privBody.conversationId) throw new Error(`Seeding private conversation failed: ${JSON.stringify(privRes.data)}`)

  // Thread under the public channel with its own conversation (INV-62: access
  // resolves through the root, and the feed matches on the effective root).
  const parentRes = await client.post<{ message: { id: string } }>(`/api/workspaces/${workspace.id}/messages`, {
    streamId: publicChannel.id,
    content: `thread parent ${testRunId}`,
  })
  const parentMessageId = (parentRes.data as { message: { id: string } }).message.id
  const thread = await createThread(client, workspace.id, publicChannel.id, parentMessageId)
  const threadMsgRes = await client.post<{ message: { id: string }; conversationId?: string }>(
    `/api/workspaces/${workspace.id}/messages`,
    { streamId: thread.id, content: `thread reply ${testRunId}`, conversation: { intent: "new" } }
  )
  const threadBody = threadMsgRes.data as { conversationId?: string }
  if (!threadBody.conversationId) throw new Error("Seeding thread conversation failed")

  return {
    client,
    workspaceId: workspace.id,
    publicChannelId: publicChannel.id,
    secondPublicChannelId: secondPublicChannel.id,
    privateChannelId: privateChannel.id,
    threadStreamId: thread.id,
    publicConversationId: seeded.body.conversationId,
    secondConversationId: seededSecond.body.conversationId!,
    privateConversationId: privBody.conversationId,
    threadConversationId: threadBody.conversationId!,
    botReadWriteKey,
    streamsReadOnlyKey,
    userKey,
  }
}

describe("Public API v1 — Conversations", () => {
  let ctx: TestContext

  beforeAll(async () => {
    pool = createTestPool()
    ctx = await setupTestWorkspace()
  })

  afterAll(async () => {
    await pool.end()
  })

  describe("sendMessage conversation directive", () => {
    test("intent existing appends to the conversation and echoes conversationId", async () => {
      const res = await sendViaPublicApi(ctx, ctx.publicChannelId, `follow-up ${testRunId}`, {
        intent: "existing",
        conversationId: ctx.publicConversationId,
      })
      expect(res.status).toBe(201)
      expect(res.body.conversationId).toBe(ctx.publicConversationId)

      const get = await apiGet(
        `/api/v1/workspaces/${ctx.workspaceId}/conversations/${ctx.publicConversationId}`,
        ctx.botReadWriteKey
      )
      const body = (await get.json()) as { data: WireConversation }
      expect(body.data.messageCount).toBeGreaterThanOrEqual(2)
    })

    test("intent existing across roots returns 400 CONVERSATION_NOT_IN_ROOT", async () => {
      const res = await sendViaPublicApi(ctx, ctx.publicChannelId, `wrong root ${testRunId}`, {
        intent: "existing",
        conversationId: ctx.secondConversationId,
      })
      expect(res.status).toBe(400)
      expect(res.body.code).toBe("CONVERSATION_NOT_IN_ROOT")
    })

    test("intent existing with unknown id returns 400 CONVERSATION_NOT_FOUND", async () => {
      const res = await sendViaPublicApi(ctx, ctx.publicChannelId, `missing conv ${testRunId}`, {
        intent: "existing",
        conversationId: "conv_00000000000000000000000000",
      })
      expect(res.status).toBe(400)
      expect(res.body.code).toBe("CONVERSATION_NOT_FOUND")
    })

    test("undeclared send still returns 201 without conversationId", async () => {
      const res = await sendViaPublicApi(ctx, ctx.publicChannelId, `plain send ${testRunId}`)
      expect(res.status).toBe(201)
      expect(res.body.conversationId).toBeUndefined()
    })
  })

  describe("getConversation", () => {
    test("returns the conversation with root and counts", async () => {
      const res = await apiGet(
        `/api/v1/workspaces/${ctx.workspaceId}/conversations/${ctx.publicConversationId}`,
        ctx.botReadWriteKey
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { data: WireConversation }
      expect(body.data).toMatchObject({
        id: ctx.publicConversationId,
        streamId: ctx.publicChannelId,
        rootStreamId: ctx.publicChannelId,
        status: "active",
      })
      expect(body.data.messageCount).toBeGreaterThanOrEqual(1)
      expect(body.data.participantIds.length).toBeGreaterThanOrEqual(1)
    })

    test("thread-anchored conversation resolves rootStreamId to the channel", async () => {
      const res = await apiGet(
        `/api/v1/workspaces/${ctx.workspaceId}/conversations/${ctx.threadConversationId}`,
        ctx.botReadWriteKey
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { data: WireConversation }
      expect(body.data.streamId).toBe(ctx.threadStreamId)
      expect(body.data.rootStreamId).toBe(ctx.publicChannelId)
    })

    test("bot key gets 403 for a private-channel conversation", async () => {
      const res = await apiGet(
        `/api/v1/workspaces/${ctx.workspaceId}/conversations/${ctx.privateConversationId}`,
        ctx.botReadWriteKey
      )
      expect(res.status).toBe(403)
    })

    test("user key reads the private-channel conversation (member)", async () => {
      const res = await apiGet(
        `/api/v1/workspaces/${ctx.workspaceId}/conversations/${ctx.privateConversationId}`,
        ctx.userKey
      )
      expect(res.status).toBe(200)
    })

    test("unknown id returns 404", async () => {
      const res = await apiGet(
        `/api/v1/workspaces/${ctx.workspaceId}/conversations/conv_00000000000000000000000000`,
        ctx.botReadWriteKey
      )
      expect(res.status).toBe(404)
    })

    test("returns 404 without messages:read scope", async () => {
      const res = await apiGet(
        `/api/v1/workspaces/${ctx.workspaceId}/conversations/${ctx.publicConversationId}`,
        ctx.streamsReadOnlyKey
      )
      expect(res.status).toBe(404)
    })
  })

  describe("listConversations", () => {
    test("bot key sees public conversations (incl. thread-anchored) but not private", async () => {
      const res = await apiGet(`/api/v1/workspaces/${ctx.workspaceId}/conversations`, ctx.botReadWriteKey)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { data: WireConversation[]; hasMore: boolean; cursor: string | null }
      const ids = body.data.map((c) => c.id)
      expect(ids).toContain(ctx.publicConversationId)
      expect(ids).toContain(ctx.threadConversationId)
      expect(ids).not.toContain(ctx.privateConversationId)
    })

    test("user key sees the private conversation too", async () => {
      const res = await apiGet(`/api/v1/workspaces/${ctx.workspaceId}/conversations`, ctx.userKey)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { data: WireConversation[] }
      const ids = body.data.map((c) => c.id)
      expect(ids).toContain(ctx.publicConversationId)
      expect(ids).toContain(ctx.privateConversationId)
    })

    test("streamId filter scopes to that root (threads included)", async () => {
      const res = await apiGet(
        `/api/v1/workspaces/${ctx.workspaceId}/conversations?streamId=${ctx.publicChannelId}`,
        ctx.botReadWriteKey
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { data: WireConversation[] }
      const ids = body.data.map((c) => c.id)
      expect(ids).toContain(ctx.publicConversationId)
      expect(ids).toContain(ctx.threadConversationId)
      expect(ids).not.toContain(ctx.secondConversationId)
      for (const c of body.data) {
        expect(c.rootStreamId).toBe(ctx.publicChannelId)
      }
    })

    test("status filter applies", async () => {
      const res = await apiGet(
        `/api/v1/workspaces/${ctx.workspaceId}/conversations?status=resolved`,
        ctx.botReadWriteKey
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { data: WireConversation[] }
      expect(body.data.map((c) => c.id)).not.toContain(ctx.publicConversationId)
    })

    test("cursor pagination pages without overlap", async () => {
      const first = await apiGet(`/api/v1/workspaces/${ctx.workspaceId}/conversations?limit=1`, ctx.botReadWriteKey)
      expect(first.status).toBe(200)
      const firstBody = (await first.json()) as { data: WireConversation[]; hasMore: boolean; cursor: string }
      expect(firstBody.data.length).toBe(1)
      expect(firstBody.hasMore).toBe(true)
      expect(firstBody.cursor).toBeTruthy()

      const second = await apiGet(
        `/api/v1/workspaces/${ctx.workspaceId}/conversations?limit=10&after=${encodeURIComponent(firstBody.cursor)}`,
        ctx.botReadWriteKey
      )
      expect(second.status).toBe(200)
      const secondBody = (await second.json()) as { data: WireConversation[] }
      expect(secondBody.data.map((c) => c.id)).not.toContain(firstBody.data[0].id)
    })

    test("invalid cursor returns 400", async () => {
      const res = await apiGet(
        `/api/v1/workspaces/${ctx.workspaceId}/conversations?after=not-a-cursor`,
        ctx.botReadWriteKey
      )
      expect(res.status).toBe(400)
    })
  })

  describe("listConversationMessages", () => {
    test("returns member messages in chronological order", async () => {
      const res = await apiGet(
        `/api/v1/workspaces/${ctx.workspaceId}/conversations/${ctx.publicConversationId}/messages`,
        ctx.botReadWriteKey
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { data: WireMessage[]; hasMore: boolean; cursor: string | null }
      expect(body.data.length).toBeGreaterThanOrEqual(2)
      expect(body.data[0].content).toContain("opening post")
      const times = body.data.map((m) => new Date(m.createdAt).getTime())
      expect([...times].sort((a, b) => a - b)).toEqual(times)
    })

    test("paginates with cursor", async () => {
      const first = await apiGet(
        `/api/v1/workspaces/${ctx.workspaceId}/conversations/${ctx.publicConversationId}/messages?limit=1`,
        ctx.botReadWriteKey
      )
      const firstBody = (await first.json()) as { data: WireMessage[]; hasMore: boolean; cursor: string }
      expect(firstBody.data.length).toBe(1)
      expect(firstBody.hasMore).toBe(true)

      const second = await apiGet(
        `/api/v1/workspaces/${ctx.workspaceId}/conversations/${ctx.publicConversationId}/messages?limit=50&after=${encodeURIComponent(firstBody.cursor)}`,
        ctx.botReadWriteKey
      )
      const secondBody = (await second.json()) as { data: WireMessage[] }
      expect(secondBody.data.map((m) => m.id)).not.toContain(firstBody.data[0].id)
      expect(secondBody.data.length).toBeGreaterThanOrEqual(1)
    })

    test("bot key gets 403 for a private conversation's messages", async () => {
      const res = await apiGet(
        `/api/v1/workspaces/${ctx.workspaceId}/conversations/${ctx.privateConversationId}/messages`,
        ctx.botReadWriteKey
      )
      expect(res.status).toBe(403)
    })
  })
})
