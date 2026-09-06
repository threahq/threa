/**
 * E2E tests for OpenAPI spec accuracy.
 *
 * Validates that the generated OpenAPI spec matches actual API behavior by:
 * 1. Calling every documented endpoint
 * 2. Validating response shapes against the route registry's Zod schemas
 * 3. Verifying status codes, content types, and error responses
 *
 * Run with: bun test --preload ./tests/setup.ts tests/e2e/public-api-openapi.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Pool } from "pg"
import { AttachmentSafetyStatuses, ExtractionContentTypes, KnowledgeTypes, MemoTypes } from "@threahq/types"
import { TestClient, loginAs, createWorkspace, createChannel, sendMessage } from "../client"
import {
  PUBLIC_API_ROUTES,
  streamSchema,
  messageSchema,
  searchResultSchema,
  memberSchema,
  userSchema,
  memoSearchResultSchema,
  memoDetailSchema,
  attachmentSearchResultSchema,
  attachmentDetailsSchema,
  attachmentUrlSchema,
} from "../../src/features/public-api/routes"
import { AttachmentExtractionRepository, AttachmentRepository } from "../../src/features/attachments"
import { MemoRepository } from "../../src/features/memos"
import { attachmentId, extractionId, memoId } from "../../src/lib/id"
import { readFileSync } from "fs"
import { resolve } from "path"
import { createTestPool } from "../integration/setup"

const testRunId = Math.random().toString(36).substring(7)
const testEmail = (name: string) => `${name}-openapi-${testRunId}@test.com`

interface TestContext {
  workspaceId: string
  channelId: string
  messageId: string
  userId: string
  memoId: string
  attachmentId: string
  allScopesKey: string
  readOnlyKey: string
}

const baseUrl = () => process.env.TEST_BASE_URL || "http://localhost:3001"

function apiRequest(method: string, path: string, apiKey: string, body?: unknown) {
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` }
  if (body) headers["Content-Type"] = "application/json"
  return fetch(`${baseUrl()}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
}

async function setupTestWorkspace(pool: Pool): Promise<TestContext> {
  const client = new TestClient()
  await loginAs(client, testEmail("setup"), `OpenAPIUser ${testRunId}`)
  const workspace = await createWorkspace(client, `OpenAPI WS ${testRunId}`)

  const channel = await createChannel(client, workspace.id, `oa-chan-${testRunId}`, "public")
  const msg = await sendMessage(client, workspace.id, channel.id, `OpenAPI test message ${testRunId}`)

  const insertedMemoId = memoId()
  await MemoRepository.insert(pool, {
    id: insertedMemoId,
    workspaceId: workspace.id,
    memoType: MemoTypes.MESSAGE,
    sourceMessageId: msg.id,
    title: `OpenAPI memo ${testRunId}`,
    abstract: `OpenAPI memo abstract ${testRunId}`,
    sourceMessageIds: [msg.id],
    participantIds: [msg.authorId],
    knowledgeType: KnowledgeTypes.DECISION,
  })

  const attachmentMessage = await sendMessage(client, workspace.id, channel.id, `OpenAPI attachment ${testRunId}`)
  const attachment = attachmentId()
  await AttachmentRepository.insert(pool, {
    id: attachment,
    workspaceId: workspace.id,
    uploadedBy: attachmentMessage.authorId,
    filename: `openapi-attachment-${testRunId}.bin`,
    mimeType: "application/octet-stream",
    sizeBytes: 64,
    storagePath: `tests/openapi-attachment-${testRunId}.bin`,
    safetyStatus: AttachmentSafetyStatuses.CLEAN,
  })
  await AttachmentRepository.attachToMessage(pool, [attachment], attachmentMessage.id, channel.id)
  await AttachmentExtractionRepository.insert(pool, {
    id: extractionId(),
    attachmentId: attachment,
    workspaceId: workspace.id,
    contentType: ExtractionContentTypes.DOCUMENT,
    summary: `OpenAPI attachment summary ${testRunId}`,
    fullText: `OpenAPI attachment full text ${testRunId}`,
  })

  const { data: bootstrapData } = await client.get<{
    data: { users: Array<{ id: string }> }
  }>(`/api/workspaces/${workspace.id}/bootstrap`)

  // Create bot with all scopes
  const botRes = await client.post(`/api/workspaces/${workspace.id}/bots`, {
    type: "shared",
    name: `OpenAPI Bot ${testRunId}`,
    slug: `oa-bot-${testRunId}`,
  })
  const botId = (botRes.data as { data: { id: string } }).data.id
  const grantRes = await client.post(`/api/workspaces/${workspace.id}/bots/${botId}/streams/${channel.id}/grant`, {})
  if (grantRes.status !== 204) {
    throw new Error(`Grant bot stream access failed (${grantRes.status}): ${JSON.stringify(grantRes.data)}`)
  }

  const allKeyRes = await client.post(`/api/workspaces/${workspace.id}/bots/${botId}/keys`, {
    name: "all-scopes",
    scopes: [
      "streams:read",
      "messages:read",
      "messages:write",
      "users:read",
      "messages:search",
      "memos:read",
      "attachments:read",
    ],
  })
  const allScopesKey = (allKeyRes.data as { value: string }).value

  const readKeyRes = await client.post(`/api/workspaces/${workspace.id}/bots/${botId}/keys`, {
    name: "read-only",
    scopes: ["streams:read"],
  })
  const readOnlyKey = (readKeyRes.data as { value: string }).value

  return {
    workspaceId: workspace.id,
    channelId: channel.id,
    messageId: msg.id,
    userId: bootstrapData.data.users[0].id,
    memoId: insertedMemoId,
    attachmentId: attachment,
    allScopesKey,
    readOnlyKey,
  }
}

describe("Public API — OpenAPI Spec Validation", () => {
  let ctx: TestContext
  let pool: Pool

  beforeAll(async () => {
    pool = createTestPool()
    ctx = await setupTestWorkspace(pool)
  })

  afterAll(async () => {
    await pool.end()
  })

  test("openapi.json file exists and is valid JSON", () => {
    const specPath = resolve(import.meta.dirname!, "../../../../docs/public-api/openapi.json")
    const raw = readFileSync(specPath, "utf-8")
    const spec = JSON.parse(raw)
    expect(spec.openapi).toBe("3.0.3")
    expect(spec.info.title).toBe("Threa Public API")
  })

  test("spec covers all routes in the registry", () => {
    const specPath = resolve(import.meta.dirname!, "../../../../docs/public-api/openapi.json")
    const spec = JSON.parse(readFileSync(specPath, "utf-8"))

    for (const route of PUBLIC_API_ROUTES) {
      const pathObj = spec.paths[route.path]
      expect(pathObj).toBeDefined()
      expect(pathObj[route.method]).toBeDefined()
      expect(pathObj[route.method].operationId).toBe(route.operationId)
    }
  })

  test("spec declares correct scopes for each operation", () => {
    const specPath = resolve(import.meta.dirname!, "../../../../docs/public-api/openapi.json")
    const spec = JSON.parse(readFileSync(specPath, "utf-8"))

    for (const route of PUBLIC_API_ROUTES) {
      const op = spec.paths[route.path][route.method]
      const declaredScopes = op.security?.[0]?.apiKey ?? []
      expect(declaredScopes).toEqual(route.scopes)
    }
  })

  test("spec declares every tag its operations use", () => {
    // The reference site renders groups from spec.tags; an operation tag missing
    // from that array reads as an undescribed group and was silently dropped by
    // the old hardcoded allowlist. Keep the declaration exhaustive.
    const specPath = resolve(import.meta.dirname!, "../../../../docs/public-api/openapi.json")
    const spec = JSON.parse(readFileSync(specPath, "utf-8"))

    const declared = new Set<string>((spec.tags ?? []).map((t: { name: string }) => t.name))
    const usedTags = new Set<string>()
    for (const route of PUBLIC_API_ROUTES) for (const tag of route.tags ?? []) usedTags.add(tag)

    const undeclared = [...usedTags].filter((tag) => !declared.has(tag))
    expect(undeclared).toEqual([])
  })

  describe("Response shape validation", () => {
    test("GET /streams returns data matching streamSchema", async () => {
      const res = await apiRequest("GET", `/api/v1/workspaces/${ctx.workspaceId}/streams`, ctx.allScopesKey)
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.data).toBeArray()
      expect(body).toHaveProperty("hasMore")
      expect(body).toHaveProperty("cursor")

      for (const item of body.data) {
        const parsed = streamSchema.safeParse(item)
        expect(parsed.success).toBe(true)
      }
    })

    test("GET /streams/:streamId returns data matching streamSchema", async () => {
      const res = await apiRequest(
        "GET",
        `/api/v1/workspaces/${ctx.workspaceId}/streams/${ctx.channelId}`,
        ctx.allScopesKey
      )
      expect(res.status).toBe(200)

      const body = await res.json()
      const parsed = streamSchema.safeParse(body.data)
      expect(parsed.success).toBe(true)
    })

    test("GET /streams/:streamId/members returns data matching memberSchema", async () => {
      const res = await apiRequest(
        "GET",
        `/api/v1/workspaces/${ctx.workspaceId}/streams/${ctx.channelId}/members`,
        ctx.allScopesKey
      )
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.data).toBeArray()
      expect(body).toHaveProperty("hasMore")

      for (const item of body.data) {
        const parsed = memberSchema.safeParse(item)
        expect(parsed.success).toBe(true)
      }
    })

    test("GET /streams/:streamId/messages returns data matching messageSchema", async () => {
      const res = await apiRequest(
        "GET",
        `/api/v1/workspaces/${ctx.workspaceId}/streams/${ctx.channelId}/messages`,
        ctx.allScopesKey
      )
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.data).toBeArray()
      expect(body).toHaveProperty("hasMore")

      for (const item of body.data) {
        const parsed = messageSchema.safeParse(item)
        expect(parsed.success).toBe(true)
      }
    })

    test("POST /streams/:streamId/messages returns data matching messageSchema", async () => {
      const res = await apiRequest(
        "POST",
        `/api/v1/workspaces/${ctx.workspaceId}/streams/${ctx.channelId}/messages`,
        ctx.allScopesKey,
        { content: `OpenAPI send test ${testRunId}` }
      )
      expect(res.status).toBe(201)

      const body = await res.json()
      const parsed = messageSchema.safeParse(body.data)
      expect(parsed.success).toBe(true)
    })

    test("POST /messages/find-by-metadata returns data matching messageSchema", async () => {
      // Seed a message with metadata so the find has something to return.
      const tag = `openapi-find-${testRunId}`
      await apiRequest(
        "POST",
        `/api/v1/workspaces/${ctx.workspaceId}/streams/${ctx.channelId}/messages`,
        ctx.allScopesKey,
        { content: `OpenAPI find test ${testRunId}`, metadata: { "test.tag": tag } }
      )

      const res = await apiRequest(
        "POST",
        `/api/v1/workspaces/${ctx.workspaceId}/messages/find-by-metadata`,
        ctx.allScopesKey,
        { metadata: { "test.tag": tag } }
      )
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.data).toBeArray()
      expect(body.data.length).toBeGreaterThanOrEqual(1)
      for (const item of body.data) {
        const parsed = messageSchema.safeParse(item)
        expect(parsed.success).toBe(true)
      }
    })

    test("PATCH /messages/:messageId returns data matching messageSchema", async () => {
      const sendRes = await apiRequest(
        "POST",
        `/api/v1/workspaces/${ctx.workspaceId}/streams/${ctx.channelId}/messages`,
        ctx.allScopesKey,
        { content: `Will be updated ${testRunId}` }
      )
      const sentMsg = (await sendRes.json()).data

      const res = await apiRequest(
        "PATCH",
        `/api/v1/workspaces/${ctx.workspaceId}/messages/${sentMsg.id}`,
        ctx.allScopesKey,
        { content: `Updated content ${testRunId}` }
      )
      expect(res.status).toBe(200)

      const body = await res.json()
      const parsed = messageSchema.safeParse(body.data)
      expect(parsed.success).toBe(true)
      expect(body.data.content).toContain("Updated content")
    })

    test("DELETE /messages/:messageId returns 204", async () => {
      const sendRes = await apiRequest(
        "POST",
        `/api/v1/workspaces/${ctx.workspaceId}/streams/${ctx.channelId}/messages`,
        ctx.allScopesKey,
        { content: `Will be deleted ${testRunId}` }
      )
      const sentMsg = (await sendRes.json()).data

      const res = await apiRequest(
        "DELETE",
        `/api/v1/workspaces/${ctx.workspaceId}/messages/${sentMsg.id}`,
        ctx.allScopesKey
      )
      expect(res.status).toBe(204)
    })

    test("POST /messages/search returns data matching searchResultSchema", async () => {
      const res = await apiRequest("POST", `/api/v1/workspaces/${ctx.workspaceId}/messages/search`, ctx.allScopesKey, {
        query: "OpenAPI test message",
      })
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.data).toBeArray()

      for (const item of body.data) {
        const parsed = searchResultSchema.safeParse(item)
        expect(parsed.success).toBe(true)
      }
    })

    test("POST /memos/search returns data matching memoSearchResultSchema", async () => {
      const res = await apiRequest("POST", `/api/v1/workspaces/${ctx.workspaceId}/memos/search`, ctx.allScopesKey, {
        query: "OpenAPI memo abstract",
      })
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.data).toBeArray()

      for (const item of body.data) {
        const parsed = memoSearchResultSchema.safeParse(item)
        expect(parsed.success).toBe(true)
      }
    })

    test("GET /memos/:memoId returns data matching memoDetailSchema", async () => {
      const res = await apiRequest("GET", `/api/v1/workspaces/${ctx.workspaceId}/memos/${ctx.memoId}`, ctx.allScopesKey)
      expect(res.status).toBe(200)

      const body = await res.json()
      const parsed = memoDetailSchema.safeParse(body.data)
      expect(parsed.success).toBe(true)
    })

    test("POST /attachments/search returns data matching attachmentSearchResultSchema", async () => {
      const res = await apiRequest(
        "POST",
        `/api/v1/workspaces/${ctx.workspaceId}/attachments/search`,
        ctx.allScopesKey,
        { query: "openapi-attachment" }
      )
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.data).toBeArray()

      for (const item of body.data) {
        const parsed = attachmentSearchResultSchema.safeParse(item)
        expect(parsed.success).toBe(true)
      }
    })

    test("GET /attachments/:attachmentId returns data matching attachmentDetailsSchema", async () => {
      const res = await apiRequest(
        "GET",
        `/api/v1/workspaces/${ctx.workspaceId}/attachments/${ctx.attachmentId}`,
        ctx.allScopesKey
      )
      expect(res.status).toBe(200)

      const body = await res.json()
      const parsed = attachmentDetailsSchema.safeParse(body.data)
      expect(parsed.success).toBe(true)
    })

    test("GET /attachments/:attachmentId/url returns data matching attachmentUrlSchema", async () => {
      const res = await apiRequest(
        "GET",
        `/api/v1/workspaces/${ctx.workspaceId}/attachments/${ctx.attachmentId}/url`,
        ctx.allScopesKey
      )
      expect(res.status).toBe(200)

      const body = await res.json()
      const parsed = attachmentUrlSchema.safeParse(body.data)
      expect(parsed.success).toBe(true)
    })

    test("GET /users returns data matching userSchema", async () => {
      const res = await apiRequest("GET", `/api/v1/workspaces/${ctx.workspaceId}/users`, ctx.allScopesKey)
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.data).toBeArray()
      expect(body).toHaveProperty("hasMore")

      for (const item of body.data) {
        const parsed = userSchema.safeParse(item)
        expect(parsed.success).toBe(true)
      }
    })
  })

  describe("Error response validation", () => {
    test("401 for missing auth header", async () => {
      const res = await fetch(`${baseUrl()}/api/v1/workspaces/${ctx.workspaceId}/streams`)
      expect(res.status).toBe(401)
    })

    test("404 for insufficient scope", async () => {
      const res = await apiRequest(
        "POST",
        `/api/v1/workspaces/${ctx.workspaceId}/streams/${ctx.channelId}/messages`,
        ctx.readOnlyKey,
        { content: "should fail" }
      )
      expect(res.status).toBe(404)
    })

    test("400 for invalid request body", async () => {
      const res = await apiRequest("POST", `/api/v1/workspaces/${ctx.workspaceId}/messages/search`, ctx.allScopesKey, {
        query: "",
      })
      expect(res.status).toBe(400)

      const body = await res.json()
      expect(body).toHaveProperty("error")
    })
  })
})
