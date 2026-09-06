/**
 * E2E tests for public API v1 knowledge retrieval endpoints.
 *
 * Run with: bun test --preload ./tests/setup.ts tests/e2e/public-api-knowledge.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Pool } from "pg"
import { AttachmentSafetyStatuses, ExtractionContentTypes, KnowledgeTypes, MemoTypes } from "@threahq/types"
import { AttachmentExtractionRepository, AttachmentRepository } from "../../src/features/attachments"
import { MemoRepository } from "../../src/features/memos"
import { attachmentId, extractionId, memoId } from "../../src/lib/id"
import { TestClient, createChannel, createWorkspace, loginAs, sendMessage } from "../client"
import { createTestPool } from "../integration/setup"

const testRunId = Math.random().toString(36).slice(2)
const testEmail = (name: string) => `${name}-knowledge-${testRunId}@test.com`

interface TestContext {
  workspaceId: string
  publicMemoId: string
  privateMemoId: string
  publicAttachmentId: string
  privateAttachmentId: string
  blockedAttachmentId: string
  memoKey: string
  attachmentKey: string
  noScopeKey: string
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
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
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

describe("Public API v1 — Knowledge Retrieval", () => {
  let pool: Pool
  let ctx: TestContext

  beforeAll(async () => {
    pool = createTestPool()

    const client = new TestClient()
    await loginAs(client, testEmail("setup"), `Knowledge User ${testRunId}`)
    const workspace = await createWorkspace(client, `Knowledge WS ${testRunId}`)

    const publicChannel = await createChannel(client, workspace.id, `knowledge-public-${testRunId}`, "public")
    const privateChannel = await createChannel(client, workspace.id, `knowledge-private-${testRunId}`, "private")

    const publicMemoMessage = await sendMessage(client, workspace.id, publicChannel.id, `Public memo seed ${testRunId}`)
    const privateMemoMessage = await sendMessage(
      client,
      workspace.id,
      privateChannel.id,
      `Private memo seed ${testRunId}`
    )

    const publicMemoId = memoId()
    await MemoRepository.insert(pool, {
      id: publicMemoId,
      workspaceId: workspace.id,
      memoType: MemoTypes.MESSAGE,
      sourceMessageId: publicMemoMessage.id,
      title: `Public memo ${testRunId}`,
      abstract: `Public planning memo ${testRunId} captures the approved rollout.`,
      sourceMessageIds: [publicMemoMessage.id],
      participantIds: [publicMemoMessage.authorId],
      knowledgeType: KnowledgeTypes.DECISION,
      tags: ["public-api"],
    })

    const privateMemoId = memoId()
    await MemoRepository.insert(pool, {
      id: privateMemoId,
      workspaceId: workspace.id,
      memoType: MemoTypes.MESSAGE,
      sourceMessageId: privateMemoMessage.id,
      title: `Private memo ${testRunId}`,
      abstract: `Private planning memo ${testRunId} must stay restricted.`,
      sourceMessageIds: [privateMemoMessage.id],
      participantIds: [privateMemoMessage.authorId],
      knowledgeType: KnowledgeTypes.DECISION,
      tags: ["private-only"],
    })

    const publicAttachmentMessage = await sendMessage(
      client,
      workspace.id,
      publicChannel.id,
      `Public attachment ${testRunId}`
    )
    const publicAttachmentId = attachmentId()
    await AttachmentRepository.insert(pool, {
      id: publicAttachmentId,
      workspaceId: workspace.id,
      uploadedBy: publicAttachmentMessage.authorId,
      filename: `public-attachment-${testRunId}.bin`,
      mimeType: "application/octet-stream",
      sizeBytes: 64,
      storagePath: `tests/public-attachment-${testRunId}.bin`,
      safetyStatus: AttachmentSafetyStatuses.CLEAN,
    })
    await AttachmentRepository.attachToMessage(pool, [publicAttachmentId], publicAttachmentMessage.id, publicChannel.id)
    await AttachmentExtractionRepository.insert(pool, {
      id: extractionId(),
      attachmentId: publicAttachmentId,
      workspaceId: workspace.id,
      contentType: ExtractionContentTypes.DOCUMENT,
      summary: `Public attachment summary ${testRunId}`,
      fullText: `Public attachment full text ${testRunId}`,
    })

    const privateAttachmentMessage = await sendMessage(
      client,
      workspace.id,
      privateChannel.id,
      `Private attachment ${testRunId}`
    )
    const privateAttachmentId = attachmentId()
    await AttachmentRepository.insert(pool, {
      id: privateAttachmentId,
      workspaceId: workspace.id,
      uploadedBy: privateAttachmentMessage.authorId,
      filename: `private-attachment-${testRunId}.bin`,
      mimeType: "application/octet-stream",
      sizeBytes: 64,
      storagePath: `tests/private-attachment-${testRunId}.bin`,
      safetyStatus: AttachmentSafetyStatuses.CLEAN,
    })
    await AttachmentRepository.attachToMessage(
      pool,
      [privateAttachmentId],
      privateAttachmentMessage.id,
      privateChannel.id
    )
    await AttachmentExtractionRepository.insert(pool, {
      id: extractionId(),
      attachmentId: privateAttachmentId,
      workspaceId: workspace.id,
      contentType: ExtractionContentTypes.DOCUMENT,
      summary: `Private attachment summary ${testRunId}`,
      fullText: `Private attachment full text ${testRunId}`,
    })

    const blockedAttachmentMessage = await sendMessage(
      client,
      workspace.id,
      publicChannel.id,
      `Blocked attachment ${testRunId}`
    )
    const blockedAttachmentId = attachmentId()
    await AttachmentRepository.insert(pool, {
      id: blockedAttachmentId,
      workspaceId: workspace.id,
      uploadedBy: blockedAttachmentMessage.authorId,
      filename: `blocked-attachment-${testRunId}.bin`,
      mimeType: "application/octet-stream",
      sizeBytes: 64,
      storagePath: `tests/blocked-attachment-${testRunId}.bin`,
      safetyStatus: AttachmentSafetyStatuses.QUARANTINED,
    })
    // Bypass attachToMessage (which only updates rows with safety_status = 'clean') so the
    // quarantined attachment gets a real stream_id — exercises the actual safety filters.
    await pool.query(`UPDATE attachments SET stream_id = $1, message_id = $2 WHERE id = $3`, [
      publicChannel.id,
      blockedAttachmentMessage.id,
      blockedAttachmentId,
    ])
    await AttachmentExtractionRepository.insert(pool, {
      id: extractionId(),
      attachmentId: blockedAttachmentId,
      workspaceId: workspace.id,
      contentType: ExtractionContentTypes.DOCUMENT,
      summary: `Blocked attachment summary ${testRunId}`,
      fullText: `Blocked attachment full text ${testRunId}`,
    })

    const botRes = await client.post(`/api/workspaces/${workspace.id}/bots`, {
      type: "shared",
      name: `Knowledge Bot ${testRunId}`,
      slug: `knowledge-bot-${testRunId}`,
    })
    const botId = (botRes.data as { data: { id: string } }).data.id

    const memoKey = await createBotKey(client, workspace.id, botId, "memo-read", ["memos:read"])
    const attachmentKey = await createBotKey(client, workspace.id, botId, "attachment-read", ["attachments:read"])
    const noScopeKey = await createBotKey(client, workspace.id, botId, "streams-only", ["streams:read"])

    expect(typeof publicAttachmentMessage.id).toBe("string")

    ctx = {
      workspaceId: workspace.id,
      publicMemoId,
      privateMemoId,
      publicAttachmentId,
      privateAttachmentId,
      blockedAttachmentId,
      memoKey,
      attachmentKey,
      noScopeKey,
    }
  })

  afterAll(async () => {
    await pool.end()
  })

  test("searches accessible memos and hides private memo results", async () => {
    const res = await apiPost(
      `/api/v1/workspaces/${ctx.workspaceId}/memos/search`,
      { query: `"planning memo ${testRunId}"` },
      ctx.memoKey
    )
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      data: Array<{ memo: { id: string; abstract: string } }>
    }

    expect(body.data.map((item) => item.memo.id)).toContain(ctx.publicMemoId)
    expect(body.data.map((item) => item.memo.id)).not.toContain(ctx.privateMemoId)
  })

  test("returns memo provenance and hides inaccessible memo details", async () => {
    const detailRes = await apiGet(`/api/v1/workspaces/${ctx.workspaceId}/memos/${ctx.publicMemoId}`, ctx.memoKey)
    expect(detailRes.status).toBe(200)

    const detailBody = (await detailRes.json()) as {
      data: {
        memo: { id: string }
        sourceStream: { id: string } | null
        sourceMessages: Array<{ id: string; content: string }>
      }
    }

    expect(detailBody.data.memo.id).toBe(ctx.publicMemoId)
    expect(detailBody.data.sourceStream).not.toBeNull()
    expect(detailBody.data.sourceMessages.length).toBeGreaterThanOrEqual(1)

    const hiddenRes = await apiGet(`/api/v1/workspaces/${ctx.workspaceId}/memos/${ctx.privateMemoId}`, ctx.memoKey)
    expect(hiddenRes.status).toBe(404)
  })

  test("requires memos:read scope", async () => {
    const res = await apiPost(`/api/v1/workspaces/${ctx.workspaceId}/memos/search`, { query: "public" }, ctx.noScopeKey)
    expect(res.status).toBe(404)
  })

  test("searches accessible attachments and hides private attachment results", async () => {
    const res = await apiPost(
      `/api/v1/workspaces/${ctx.workspaceId}/attachments/search`,
      { query: `attachment-${testRunId}` },
      ctx.attachmentKey
    )
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      data: Array<{ id: string; summary: string | null }>
    }

    expect(body.data.map((item) => item.id)).toContain(ctx.publicAttachmentId)
    expect(body.data.map((item) => item.id)).not.toContain(ctx.privateAttachmentId)
    expect(body.data.map((item) => item.id)).not.toContain(ctx.blockedAttachmentId)
  })

  test("returns attachment extraction details and signed download URLs", async () => {
    const detailRes = await apiGet(
      `/api/v1/workspaces/${ctx.workspaceId}/attachments/${ctx.publicAttachmentId}`,
      ctx.attachmentKey
    )
    expect(detailRes.status).toBe(200)

    const detailBody = (await detailRes.json()) as {
      data: {
        id: string
        extraction: { summary: string; fullText: string | null } | null
      }
    }

    expect(detailBody.data.id).toBe(ctx.publicAttachmentId)
    expect(detailBody.data.extraction?.summary).toContain(testRunId)
    expect(detailBody.data.extraction?.fullText).toContain(testRunId)

    const urlRes = await apiGet(
      `/api/v1/workspaces/${ctx.workspaceId}/attachments/${ctx.publicAttachmentId}/url`,
      ctx.attachmentKey
    )
    expect(urlRes.status).toBe(200)

    const urlBody = (await urlRes.json()) as {
      data: { url: string; expiresIn: number }
    }

    expect(urlBody.data.url).toMatch(/^https?:\/\//)
    expect(urlBody.data.expiresIn).toBe(900)
  })

  test("hides inaccessible attachment details and requires attachments:read scope", async () => {
    const hiddenRes = await apiGet(
      `/api/v1/workspaces/${ctx.workspaceId}/attachments/${ctx.privateAttachmentId}`,
      ctx.attachmentKey
    )
    expect(hiddenRes.status).toBe(404)

    const blockedDetailRes = await apiGet(
      `/api/v1/workspaces/${ctx.workspaceId}/attachments/${ctx.blockedAttachmentId}`,
      ctx.attachmentKey
    )
    expect(blockedDetailRes.status).toBe(404)

    const blockedUrlRes = await apiGet(
      `/api/v1/workspaces/${ctx.workspaceId}/attachments/${ctx.blockedAttachmentId}/url`,
      ctx.attachmentKey
    )
    expect(blockedUrlRes.status).toBe(404)

    const forbiddenRes = await apiPost(
      `/api/v1/workspaces/${ctx.workspaceId}/attachments/search`,
      { query: "public" },
      ctx.noScopeKey
    )
    expect(forbiddenRes.status).toBe(404)
  })
})
