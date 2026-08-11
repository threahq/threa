/**
 * E2E tests for public API v1 — CRUD endpoints with bot API key auth.
 *
 * Run with: bun test --preload ./tests/setup.ts tests/e2e/public-api-crud.test.ts
 */

import { describe, test, expect, beforeAll } from "bun:test"
import { TestClient, loginAs, createWorkspace, createChannel, sendMessage } from "../client"

const testRunId = Math.random().toString(36).substring(7)
const testEmail = (name: string) => `${name}-crud-${testRunId}@test.com`

const BOT_NAME = `CRUD Bot ${testRunId}`
const SECOND_BOT_NAME = `Second Bot ${testRunId}`

interface TestContext {
  workspaceId: string
  publicChannelId: string
  publicChannelSlug: string
  privateChannelId: string
  publicMessageId: string
  publicMessageSequence: string
  userId: string
  userName: string
  /** Bot key with all scopes */
  allScopesKey: string
  /** Bot key with streams:read only */
  streamsReadKey: string
  /** Bot key with messages:read only */
  messagesReadKey: string
  /** Bot key with messages:write only */
  messagesWriteKey: string
  /** Bot key with users:read only */
  usersReadKey: string
  /** Bot key with messages:search only (no CRUD scopes) */
  noScopeKey: string
  /** Key from a second bot (different bot identity) */
  secondBotWriteKey: string
  /** Write key whose bot intentionally has no stream grant. */
  ungrantedBotWriteKey: string
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

function apiPatch(path: string, body: unknown, apiKey: string) {
  return fetch(`${baseUrl()}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  })
}

function apiDelete(path: string, apiKey: string) {
  return fetch(`${baseUrl()}${path}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${apiKey}` },
  })
}

async function createBotKey(
  client: TestClient,
  workspaceId: string,
  botId: string,
  name: string,
  scopes: string[]
): Promise<string> {
  const res = await client.post(`/api/workspaces/${workspaceId}/bots/${botId}/keys`, { name, scopes })
  return (res.data as { value: string }).value
}

async function setupTestWorkspace(): Promise<TestContext> {
  const client = new TestClient()
  const user = await loginAs(client, testEmail("setup"), `CrudUser ${testRunId}`)
  const workspace = await createWorkspace(client, `CRUD WS ${testRunId}`)

  const slug = `pub-crud-${testRunId}`
  const publicChannel = await createChannel(client, workspace.id, slug, "public")
  const privateChannel = await createChannel(client, workspace.id, `priv-crud-${testRunId}`, "private")

  const msg = await sendMessage(client, workspace.id, publicChannel.id, `Test message ${testRunId}`)

  // Get workspace user ID
  const { data: bootstrapData } = await client.get<{
    data: { users: Array<{ id: string; name: string; workosUserId: string }> }
  }>(`/api/workspaces/${workspace.id}/bootstrap`)
  const wsUser = bootstrapData.data.users[0]

  // Create primary bot with keys at various scope levels
  const bot1Res = await client.post(`/api/workspaces/${workspace.id}/bots`, {
    type: "shared",
    name: BOT_NAME,
    slug: `crud-bot-${testRunId}`,
  })
  const bot1Id = (bot1Res.data as { data: { id: string } }).data.id

  const allScopesKey = await createBotKey(client, workspace.id, bot1Id, "all-scopes", [
    "streams:read",
    "messages:read",
    "messages:write",
    "users:read",
  ])
  const streamsReadKey = await createBotKey(client, workspace.id, bot1Id, "streams-read", ["streams:read"])
  const messagesReadKey = await createBotKey(client, workspace.id, bot1Id, "messages-read", ["messages:read"])
  const messagesWriteKey = await createBotKey(client, workspace.id, bot1Id, "messages-write", ["messages:write"])
  const usersReadKey = await createBotKey(client, workspace.id, bot1Id, "users-read", ["users:read"])
  const noScopeKey = await createBotKey(client, workspace.id, bot1Id, "search-only", ["messages:search"])
  await client.post(`/api/workspaces/${workspace.id}/bots/${bot1Id}/streams/${publicChannel.id}/grant`, {})

  // Create second bot for cross-bot ownership tests
  const bot2Res = await client.post(`/api/workspaces/${workspace.id}/bots`, {
    type: "shared",
    name: SECOND_BOT_NAME,
    slug: `second-bot-${testRunId}`,
  })
  const bot2Id = (bot2Res.data as { data: { id: string } }).data.id
  const secondBotWriteKey = await createBotKey(client, workspace.id, bot2Id, "write", [
    "messages:write",
    "messages:read",
  ])
  await client.post(`/api/workspaces/${workspace.id}/bots/${bot2Id}/streams/${publicChannel.id}/grant`, {})

  const ungrantedBotRes = await client.post(`/api/workspaces/${workspace.id}/bots`, {
    type: "shared",
    name: `Ungranted Bot ${testRunId}`,
    slug: `ungranted-bot-${testRunId}`,
  })
  const ungrantedBotId = (ungrantedBotRes.data as { data: { id: string } }).data.id
  const ungrantedBotWriteKey = await createBotKey(client, workspace.id, ungrantedBotId, "write", ["messages:write"])

  return {
    workspaceId: workspace.id,
    publicChannelId: publicChannel.id,
    publicChannelSlug: slug,
    privateChannelId: privateChannel.id,
    publicMessageId: msg.id,
    publicMessageSequence: msg.sequence,
    userId: wsUser.id,
    userName: wsUser.name,
    allScopesKey,
    streamsReadKey,
    messagesReadKey,
    messagesWriteKey,
    usersReadKey,
    noScopeKey,
    secondBotWriteKey,
    ungrantedBotWriteKey,
  }
}

describe("Public API v1 — CRUD Endpoints", () => {
  let ctx: TestContext

  beforeAll(async () => {
    ctx = await setupTestWorkspace()
  })

  describe("List Streams", () => {
    test("should return accessible streams", async () => {
      const res = await apiGet(`/api/v1/workspaces/${ctx.workspaceId}/streams`, ctx.streamsReadKey)
      expect(res.status).toBe(200)

      const body = (await res.json()) as { data: Array<{ id: string; type: string; visibility: string }> }
      expect(body.data.length).toBeGreaterThanOrEqual(1)

      // Public channel should be accessible
      const pub = body.data.find((s) => s.id === ctx.publicChannelId)
      expect(pub).toBeDefined()
      expect(pub!.visibility).toBe("public")

      // Private channel should NOT be accessible (no grant)
      const priv = body.data.find((s) => s.id === ctx.privateChannelId)
      expect(priv).toBeUndefined()
    })

    test("should filter by type", async () => {
      const res = await apiGet(`/api/v1/workspaces/${ctx.workspaceId}/streams?type=channel`, ctx.streamsReadKey)
      expect(res.status).toBe(200)

      const body = (await res.json()) as { data: Array<{ type: string }> }
      for (const stream of body.data) {
        expect(stream.type).toBe("channel")
      }
    })

    test("should search by name", async () => {
      const res = await apiGet(
        `/api/v1/workspaces/${ctx.workspaceId}/streams?query=pub-crud-${testRunId}`,
        ctx.streamsReadKey
      )
      expect(res.status).toBe(200)

      const body = (await res.json()) as { data: Array<{ id: string }> }
      expect(body.data.length).toBeGreaterThanOrEqual(1)
      expect(body.data.some((s) => s.id === ctx.publicChannelId)).toBe(true)
    })

    test("should return #slug as displayName for channels", async () => {
      const res = await apiGet(`/api/v1/workspaces/${ctx.workspaceId}/streams`, ctx.streamsReadKey)
      expect(res.status).toBe(200)

      const body = (await res.json()) as { data: Array<{ id: string; displayName: string; slug: string }> }
      const pub = body.data.find((s) => s.id === ctx.publicChannelId)
      expect(pub).toBeDefined()
      expect(pub!.displayName).toBe(`#${ctx.publicChannelSlug}`)
      expect(pub!.slug).toBe(ctx.publicChannelSlug)
    })

    test("should return 404 without streams:read scope", async () => {
      const res = await apiGet(`/api/v1/workspaces/${ctx.workspaceId}/streams`, ctx.noScopeKey)
      expect(res.status).toBe(404)
    })
  })

  describe("Read Messages", () => {
    test("should return messages from accessible stream", async () => {
      const res = await apiGet(
        `/api/v1/workspaces/${ctx.workspaceId}/streams/${ctx.publicChannelId}/messages`,
        ctx.messagesReadKey
      )
      expect(res.status).toBe(200)

      const body = (await res.json()) as {
        data: Array<{ id: string; content: string; sequence: string }>
        hasMore: boolean
      }
      expect(body.data.length).toBeGreaterThanOrEqual(1)
      expect(typeof body.hasMore).toBe("boolean")

      const msg = body.data.find((m) => m.id === ctx.publicMessageId)
      expect(msg).toBeDefined()
      expect(msg!.content).toContain(testRunId)
    })

    test("should paginate with before cursor", async () => {
      const res = await apiGet(
        `/api/v1/workspaces/${ctx.workspaceId}/streams/${ctx.publicChannelId}/messages?before=999999999`,
        ctx.messagesReadKey
      )
      expect(res.status).toBe(200)

      const body = (await res.json()) as { data: Array<{ sequence: string }> }
      expect(body.data.length).toBeGreaterThanOrEqual(1)
    })

    test("should paginate with after cursor", async () => {
      const res = await apiGet(
        `/api/v1/workspaces/${ctx.workspaceId}/streams/${ctx.publicChannelId}/messages?after=0`,
        ctx.messagesReadKey
      )
      expect(res.status).toBe(200)

      const body = (await res.json()) as { data: Array<{ sequence: string }> }
      expect(body.data.length).toBeGreaterThanOrEqual(1)
    })

    test("should return 403 for inaccessible stream", async () => {
      const res = await apiGet(
        `/api/v1/workspaces/${ctx.workspaceId}/streams/${ctx.privateChannelId}/messages`,
        ctx.messagesReadKey
      )
      expect(res.status).toBe(403)
    })

    test("should return 404 without messages:read scope", async () => {
      const res = await apiGet(
        `/api/v1/workspaces/${ctx.workspaceId}/streams/${ctx.publicChannelId}/messages`,
        ctx.noScopeKey
      )
      expect(res.status).toBe(404)
    })
  })

  describe("Send Message", () => {
    test("denies a public-stream bot nonparticipant with structured read-only details", async () => {
      const res = await apiPost(
        `/api/v1/workspaces/${ctx.workspaceId}/streams/${ctx.publicChannelId}/messages`,
        { content: "must not commit" },
        ctx.ungrantedBotWriteKey
      )
      expect(res.status).toBe(403)
      expect(await res.json()).toMatchObject({
        code: "STREAM_READ_ONLY",
        details: { reason: "not_a_member" },
      })
    })

    test("should create a bot message with bot name as display name", async () => {
      const res = await apiPost(
        `/api/v1/workspaces/${ctx.workspaceId}/streams/${ctx.publicChannelId}/messages`,
        { content: `Bot message ${testRunId}` },
        ctx.messagesWriteKey
      )
      expect(res.status).toBe(201)

      const body = (await res.json()) as {
        data: {
          id: string
          authorId: string
          authorType: string
          authorDisplayName: string
          content: string
        }
      }
      expect(body.data.authorType).toBe("bot")
      expect(body.data.authorDisplayName).toBe(BOT_NAME)
      expect(body.data.authorId).toMatch(/^bot_/)
      expect(body.data.content).toContain(`Bot message ${testRunId}`)
    })

    test("should resolve bot display name in listMessages", async () => {
      await apiPost(
        `/api/v1/workspaces/${ctx.workspaceId}/streams/${ctx.publicChannelId}/messages`,
        { content: `List test ${testRunId}` },
        ctx.messagesWriteKey
      )

      const res = await apiGet(
        `/api/v1/workspaces/${ctx.workspaceId}/streams/${ctx.publicChannelId}/messages`,
        ctx.allScopesKey
      )
      expect(res.status).toBe(200)

      const body = (await res.json()) as {
        data: Array<{ authorType: string; authorDisplayName: string | null; content: string }>
      }

      const botMsg = body.data.find((m) => m.content.includes(`List test ${testRunId}`))
      expect(botMsg).toBeDefined()
      expect(botMsg!.authorDisplayName).toBe(BOT_NAME)

      const userMsg = body.data.find((m) => m.authorType === "user")
      expect(userMsg).toBeDefined()
      expect(userMsg!.authorDisplayName).toBeString()
    })

    test("should hide an inaccessible private stream", async () => {
      const res = await apiPost(
        `/api/v1/workspaces/${ctx.workspaceId}/streams/${ctx.privateChannelId}/messages`,
        { content: "test" },
        ctx.messagesWriteKey
      )
      expect(res.status).toBe(404)
    })

    test("should return 404 without messages:write scope", async () => {
      const res = await apiPost(
        `/api/v1/workspaces/${ctx.workspaceId}/streams/${ctx.publicChannelId}/messages`,
        { content: "test" },
        ctx.noScopeKey
      )
      expect(res.status).toBe(404)
    })

    test("should return 400 for empty content", async () => {
      const res = await apiPost(
        `/api/v1/workspaces/${ctx.workspaceId}/streams/${ctx.publicChannelId}/messages`,
        { content: "" },
        ctx.messagesWriteKey
      )
      expect(res.status).toBe(400)
    })

    test("should round-trip user-supplied metadata and return it on list", async () => {
      const metadata = {
        source: "github",
        "github.pr.id": `md-${testRunId}`,
        "github.event": "review_requested",
      }

      const sendRes = await apiPost(
        `/api/v1/workspaces/${ctx.workspaceId}/streams/${ctx.publicChannelId}/messages`,
        { content: `Metadata message ${testRunId}`, metadata },
        ctx.messagesWriteKey
      )
      expect(sendRes.status).toBe(201)

      const sendBody = (await sendRes.json()) as { data: { id: string; metadata: Record<string, string> } }
      expect(sendBody.data.metadata).toEqual(metadata)

      const listRes = await apiGet(
        `/api/v1/workspaces/${ctx.workspaceId}/streams/${ctx.publicChannelId}/messages`,
        ctx.messagesReadKey
      )
      const listBody = (await listRes.json()) as {
        data: Array<{ id: string; metadata: Record<string, string> }>
      }
      const echoed = listBody.data.find((m) => m.id === sendBody.data.id)
      expect(echoed).toBeDefined()
      expect(echoed!.metadata).toEqual(metadata)
    })

    test("should always return metadata field (empty object when unset)", async () => {
      const res = await apiPost(
        `/api/v1/workspaces/${ctx.workspaceId}/streams/${ctx.publicChannelId}/messages`,
        { content: `No metadata ${testRunId}` },
        ctx.messagesWriteKey
      )
      expect(res.status).toBe(201)
      const body = (await res.json()) as { data: { metadata: Record<string, string> } }
      expect(body.data.metadata).toEqual({})
    })

    test("should reject reserved threa.* metadata keys", async () => {
      const res = await apiPost(
        `/api/v1/workspaces/${ctx.workspaceId}/streams/${ctx.publicChannelId}/messages`,
        { content: "spoof attempt", metadata: { "threa.source": "github" } },
        ctx.messagesWriteKey
      )
      expect(res.status).toBe(400)
    })

    test("should reject metadata values that exceed the per-value limit", async () => {
      const huge = "x".repeat(300)
      const res = await apiPost(
        `/api/v1/workspaces/${ctx.workspaceId}/streams/${ctx.publicChannelId}/messages`,
        { content: "oversize", metadata: { k: huge } },
        ctx.messagesWriteKey
      )
      expect(res.status).toBe(400)
    })
  })

  describe("Find Messages by Metadata", () => {
    const runTag = `find-${testRunId}`
    let postedId: string

    test("should find a message with AND-matching metadata", async () => {
      const metadata = {
        source: "github",
        "github.pr.id": runTag,
        "github.event": "opened",
      }
      const sendRes = await apiPost(
        `/api/v1/workspaces/${ctx.workspaceId}/streams/${ctx.publicChannelId}/messages`,
        { content: `Find me ${runTag}`, metadata },
        ctx.messagesWriteKey
      )
      expect(sendRes.status).toBe(201)
      postedId = ((await sendRes.json()) as { data: { id: string } }).data.id

      const findRes = await apiPost(
        `/api/v1/workspaces/${ctx.workspaceId}/messages/find-by-metadata`,
        { metadata: { "github.pr.id": runTag, "github.event": "opened" } },
        ctx.messagesReadKey
      )
      expect(findRes.status).toBe(200)
      const body = (await findRes.json()) as {
        data: Array<{ id: string; metadata: Record<string, string> }>
      }
      expect(body.data.some((m) => m.id === postedId)).toBe(true)
      for (const m of body.data) {
        expect(m.metadata["github.pr.id"]).toBe(runTag)
        expect(m.metadata["github.event"]).toBe("opened")
      }
    })

    test("should return empty when one of the AND keys does not match", async () => {
      const findRes = await apiPost(
        `/api/v1/workspaces/${ctx.workspaceId}/messages/find-by-metadata`,
        { metadata: { "github.pr.id": runTag, "github.event": "closed" } },
        ctx.messagesReadKey
      )
      expect(findRes.status).toBe(200)
      const body = (await findRes.json()) as { data: Array<{ id: string }> }
      expect(body.data.find((m) => m.id === postedId)).toBeUndefined()
    })

    test("should honor streamId filter", async () => {
      const findRes = await apiPost(
        `/api/v1/workspaces/${ctx.workspaceId}/messages/find-by-metadata`,
        { metadata: { "github.pr.id": runTag }, streamId: ctx.publicChannelId },
        ctx.messagesReadKey
      )
      expect(findRes.status).toBe(200)
      const body = (await findRes.json()) as { data: Array<{ streamId: string }> }
      expect(body.data.length).toBeGreaterThanOrEqual(1)
      for (const m of body.data) expect(m.streamId).toBe(ctx.publicChannelId)
    })

    test("should not return messages from inaccessible streams via streamId filter", async () => {
      const findRes = await apiPost(
        `/api/v1/workspaces/${ctx.workspaceId}/messages/find-by-metadata`,
        { metadata: { "github.pr.id": runTag }, streamId: ctx.privateChannelId },
        ctx.messagesReadKey
      )
      expect(findRes.status).toBe(200)
      const body = (await findRes.json()) as { data: unknown[] }
      expect(body.data).toEqual([])
    })

    test("should return 400 for empty metadata filter", async () => {
      const findRes = await apiPost(
        `/api/v1/workspaces/${ctx.workspaceId}/messages/find-by-metadata`,
        { metadata: {} },
        ctx.messagesReadKey
      )
      expect(findRes.status).toBe(400)
    })

    test("should return 404 without messages:read scope", async () => {
      const findRes = await apiPost(
        `/api/v1/workspaces/${ctx.workspaceId}/messages/find-by-metadata`,
        { metadata: { "github.pr.id": runTag } },
        ctx.messagesWriteKey
      )
      expect(findRes.status).toBe(404)
    })
  })

  describe("Update Message", () => {
    let botMessageId: string

    beforeAll(async () => {
      const res = await apiPost(
        `/api/v1/workspaces/${ctx.workspaceId}/streams/${ctx.publicChannelId}/messages`,
        { content: `To update ${testRunId}` },
        ctx.messagesWriteKey
      )
      const body = (await res.json()) as { data: { id: string } }
      botMessageId = body.data.id
    })

    test("should update own bot message", async () => {
      const res = await apiPatch(
        `/api/v1/workspaces/${ctx.workspaceId}/messages/${botMessageId}`,
        { content: `Updated content ${testRunId}` },
        ctx.messagesWriteKey
      )
      expect(res.status).toBe(200)

      const body = (await res.json()) as { data: { content: string; editedAt: string | null } }
      expect(body.data.content).toContain(`Updated content ${testRunId}`)
      expect(body.data.editedAt).not.toBeNull()
    })

    test("should return 403 when updating message created by different bot", async () => {
      const res = await apiPatch(
        `/api/v1/workspaces/${ctx.workspaceId}/messages/${botMessageId}`,
        { content: "hacked" },
        ctx.secondBotWriteKey
      )
      expect(res.status).toBe(403)
    })

    test("should return 403 when updating message created by a user (not via API)", async () => {
      const res = await apiPatch(
        `/api/v1/workspaces/${ctx.workspaceId}/messages/${ctx.publicMessageId}`,
        { content: "hacked" },
        ctx.messagesWriteKey
      )
      expect(res.status).toBe(403)
    })

    test("should return 404 for non-existent message", async () => {
      const res = await apiPatch(
        `/api/v1/workspaces/${ctx.workspaceId}/messages/msg_nonexistent_12345`,
        { content: "nope" },
        ctx.messagesWriteKey
      )
      expect(res.status).toBe(404)
    })

    test("should return 404 when updating a soft-deleted message", async () => {
      const createRes = await apiPost(
        `/api/v1/workspaces/${ctx.workspaceId}/streams/${ctx.publicChannelId}/messages`,
        { content: `Soft-delete update test ${testRunId}` },
        ctx.messagesWriteKey
      )
      const createBody = (await createRes.json()) as { data: { id: string } }

      await apiDelete(`/api/v1/workspaces/${ctx.workspaceId}/messages/${createBody.data.id}`, ctx.messagesWriteKey)

      const res = await apiPatch(
        `/api/v1/workspaces/${ctx.workspaceId}/messages/${createBody.data.id}`,
        { content: "revived" },
        ctx.messagesWriteKey
      )
      expect(res.status).toBe(404)
    })
  })

  describe("Delete Message", () => {
    let botMessageId: string

    beforeAll(async () => {
      const res = await apiPost(
        `/api/v1/workspaces/${ctx.workspaceId}/streams/${ctx.publicChannelId}/messages`,
        { content: `To delete ${testRunId}` },
        ctx.messagesWriteKey
      )
      const body = (await res.json()) as { data: { id: string } }
      botMessageId = body.data.id
    })

    test("should delete own bot message and return 204", async () => {
      const res = await apiDelete(
        `/api/v1/workspaces/${ctx.workspaceId}/messages/${botMessageId}`,
        ctx.messagesWriteKey
      )
      expect(res.status).toBe(204)
    })

    test("should return 403 when deleting message created by different bot", async () => {
      const createRes = await apiPost(
        `/api/v1/workspaces/${ctx.workspaceId}/streams/${ctx.publicChannelId}/messages`,
        { content: `Cross-bot delete test ${testRunId}` },
        ctx.messagesWriteKey
      )
      const createBody = (await createRes.json()) as { data: { id: string } }

      const res = await apiDelete(
        `/api/v1/workspaces/${ctx.workspaceId}/messages/${createBody.data.id}`,
        ctx.secondBotWriteKey
      )
      expect(res.status).toBe(403)
    })

    test("should return 403 when deleting message not created via API", async () => {
      const res = await apiDelete(
        `/api/v1/workspaces/${ctx.workspaceId}/messages/${ctx.publicMessageId}`,
        ctx.messagesWriteKey
      )
      expect(res.status).toBe(403)
    })

    test("should return 404 when deleting an already-deleted message", async () => {
      const createRes = await apiPost(
        `/api/v1/workspaces/${ctx.workspaceId}/streams/${ctx.publicChannelId}/messages`,
        { content: `Double-delete test ${testRunId}` },
        ctx.messagesWriteKey
      )
      const createBody = (await createRes.json()) as { data: { id: string } }

      const firstDelete = await apiDelete(
        `/api/v1/workspaces/${ctx.workspaceId}/messages/${createBody.data.id}`,
        ctx.messagesWriteKey
      )
      expect(firstDelete.status).toBe(204)

      const secondDelete = await apiDelete(
        `/api/v1/workspaces/${ctx.workspaceId}/messages/${createBody.data.id}`,
        ctx.messagesWriteKey
      )
      expect(secondDelete.status).toBe(404)
    })

    test("should return 404 for non-existent message", async () => {
      const res = await apiDelete(
        `/api/v1/workspaces/${ctx.workspaceId}/messages/msg_nonexistent_12345`,
        ctx.messagesWriteKey
      )
      expect(res.status).toBe(404)
    })
  })

  describe("List Users", () => {
    test("should return workspace users", async () => {
      const res = await apiGet(`/api/v1/workspaces/${ctx.workspaceId}/users`, ctx.usersReadKey)
      expect(res.status).toBe(200)

      const body = (await res.json()) as {
        data: Array<{ id: string; name: string; email: string; role: string }>
      }
      expect(body.data.length).toBeGreaterThanOrEqual(1)

      const user = body.data.find((u) => u.id === ctx.userId)
      expect(user).toBeDefined()
      expect(user!.name).toBe(ctx.userName)
    })

    test("should search users by name", async () => {
      const res = await apiGet(`/api/v1/workspaces/${ctx.workspaceId}/users?query=CrudUser`, ctx.usersReadKey)
      expect(res.status).toBe(200)

      const body = (await res.json()) as { data: Array<{ id: string }> }
      expect(body.data.length).toBeGreaterThanOrEqual(1)
    })

    test("should return 404 without users:read scope", async () => {
      const res = await apiGet(`/api/v1/workspaces/${ctx.workspaceId}/users`, ctx.noScopeKey)
      expect(res.status).toBe(404)
    })
  })

  describe("Bootstrap includes bots", () => {
    test("should include bots array in workspace bootstrap after bot is created", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("setup"), `CrudUser ${testRunId}`)
      const { data: bootstrapData } = await client.get<{
        data: { bots: Array<{ id: string; name: string; workspaceId: string }> }
      }>(`/api/workspaces/${ctx.workspaceId}/bootstrap`)

      expect(bootstrapData.data.bots).toBeDefined()
      expect(Array.isArray(bootstrapData.data.bots)).toBe(true)
      expect(bootstrapData.data.bots.length).toBeGreaterThanOrEqual(1)

      const bot = bootstrapData.data.bots.find((b) => b.name === BOT_NAME)
      expect(bot).toBeDefined()
      expect(bot!.id).toMatch(/^bot_/)
      expect(bot!.workspaceId).toBe(ctx.workspaceId)
    })
  })
})
