import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Pool } from "pg"
import { KnowledgeTypes, MemoTypes } from "@threa/types"
import { MemoRepository } from "../../src/features/memos"
import { memoId } from "../../src/lib/id"
import {
  TestClient,
  createChannel,
  createScratchpad,
  createThread,
  createWorkspace,
  joinWorkspace,
  loginAs,
  sendMessage,
} from "../client"
import { createTestPool } from "../integration/setup"

const testRunId = Math.random().toString(36).slice(2)
const testEmail = (name: string) => `${name}-memos-${testRunId}@test.com`

interface MemoSearchApiResponse {
  results: Array<{
    memo: {
      id: string
      title: string
      abstract: string
    }
  }>
}

interface MemoDetailApiResponse {
  memo: {
    memo: {
      id: string
      title: string
    }
    sourceStream: { id: string; type: string; name: string | null } | null
    rootStream: { id: string; type: string; name: string | null } | null
    sourceMessages: Array<{
      id: string
      streamId: string
      authorName: string
      content: string
    }>
  }
}

async function insertMemo(params: {
  pool: Pool
  workspaceId: string
  sourceMessageId: string
  sourceMessageIds?: string[]
  participantIds: string[]
  title: string
  abstract: string
  knowledgeType?: (typeof KnowledgeTypes)[keyof typeof KnowledgeTypes]
}) {
  const id = memoId()

  await MemoRepository.insert(params.pool, {
    id,
    workspaceId: params.workspaceId,
    memoType: MemoTypes.MESSAGE,
    sourceMessageId: params.sourceMessageId,
    title: params.title,
    abstract: params.abstract,
    sourceMessageIds: params.sourceMessageIds ?? [params.sourceMessageId],
    participantIds: params.participantIds,
    knowledgeType: params.knowledgeType ?? KnowledgeTypes.DECISION,
  })

  return id
}

describe("Memo Explorer E2E Tests", () => {
  let pool: Pool

  beforeAll(() => {
    pool = createTestPool()
  })

  afterAll(async () => {
    await pool.end()
  })

  test("supports quoted exact memo search with case-insensitive matching", async () => {
    const client = new TestClient()
    await loginAs(client, testEmail("exact"), "Memo Exact")
    const workspace = await createWorkspace(client, `Memo Exact ${testRunId}`)
    const scratchpad = await createScratchpad(client, workspace.id, "off")
    const message = await sendMessage(client, workspace.id, scratchpad.id, "We should ship to beta customers first")

    const exactPhrase = `beta launch plan ${testRunId}`
    const matchingMemoId = await insertMemo({
      pool,
      workspaceId: workspace.id,
      sourceMessageId: message.id,
      participantIds: [message.authorId],
      title: "Launch decision",
      abstract: `The approved ${exactPhrase} is locked in.`,
    })

    await insertMemo({
      pool,
      workspaceId: workspace.id,
      sourceMessageId: message.id,
      participantIds: [message.authorId],
      title: "Launch follow-up",
      abstract: `The launch plan for ${testRunId} still needs stakeholder review.`,
    })

    const { status, data } = await client.post<MemoSearchApiResponse>(`/api/workspaces/${workspace.id}/memos/search`, {
      query: `"${exactPhrase.toUpperCase()}"`,
    })

    expect(status).toBe(200)
    expect(data.results).toHaveLength(1)
    expect(data.results[0]?.memo.id).toBe(matchingMemoId)
  })

  test("returns memo provenance including source stream, root stream, and source messages", async () => {
    const client = new TestClient()
    await loginAs(client, testEmail("detail"), "Memo Detail")
    const workspace = await createWorkspace(client, `Memo Detail ${testRunId}`)
    const channel = await createChannel(client, workspace.id, `memo-detail-${testRunId}`, "private")
    const rootMessage = await sendMessage(client, workspace.id, channel.id, "Kickoff decision")
    const thread = await createThread(client, workspace.id, channel.id, rootMessage.id)
    const threadMessage = await sendMessage(client, workspace.id, thread.id, "Finalized the launch checklist")

    const insertedMemoId = await insertMemo({
      pool,
      workspaceId: workspace.id,
      sourceMessageId: threadMessage.id,
      sourceMessageIds: [threadMessage.id, rootMessage.id],
      participantIds: [threadMessage.authorId],
      title: "Checklist finalized",
      abstract: "The launch checklist is complete and approved.",
    })

    const { status, data } = await client.get<MemoDetailApiResponse>(
      `/api/workspaces/${workspace.id}/memos/${insertedMemoId}`
    )

    expect(status).toBe(200)
    expect(data.memo.memo.id).toBe(insertedMemoId)
    expect(data.memo.sourceStream?.id).toBe(thread.id)
    expect(data.memo.rootStream?.id).toBe(channel.id)
    expect(data.memo.sourceMessages.map((message) => message.id)).toEqual([threadMessage.id, rootMessage.id])
    expect(data.memo.sourceMessages[0]?.streamId).toBe(thread.id)
  })

  test("scopes /memo search to the composing stream like an agent invoked there", async () => {
    const client = new TestClient()
    await loginAs(client, testEmail("scope"), "Memo Scope")
    const workspace = await createWorkspace(client, `Memo Scope ${testRunId}`)

    // A private scratchpad holds knowledge the owner can reach from anywhere...
    const scratchpad = await createScratchpad(client, workspace.id, "off")
    const privateMessage = await sendMessage(client, workspace.id, scratchpad.id, "Secret roadmap note")
    const scopedPhrase = `scratchpad secret ${testRunId}`
    const scratchpadMemoId = await insertMemo({
      pool,
      workspaceId: workspace.id,
      sourceMessageId: privateMessage.id,
      participantIds: [privateMessage.authorId],
      title: "Scratchpad secret",
      abstract: `This ${scopedPhrase} lives in a private scratchpad.`,
    })

    // ...and a public channel is the stream we compose `/memo` from.
    const publicChannel = await createChannel(client, workspace.id, `memo-scope-${testRunId}`, "public")

    // Without a composing stream (the memory explorer) the owner sees the memo.
    const explorerResponse = await client.post<MemoSearchApiResponse>(`/api/workspaces/${workspace.id}/memos/search`, {
      query: `"${scopedPhrase}"`,
    })
    expect(explorerResponse.status).toBe(200)
    expect(explorerResponse.data.results.map((result) => result.memo.id)).toContain(scratchpadMemoId)

    // Composing in a public channel scopes to public content only, so the
    // private-scratchpad memo is excluded — no leak into the shared stream.
    const scopedResponse = await client.post<MemoSearchApiResponse>(`/api/workspaces/${workspace.id}/memos/search`, {
      query: `"${scopedPhrase}"`,
      streamId: publicChannel.id,
    })
    expect(scopedResponse.status).toBe(200)
    expect(scopedResponse.data.results).toHaveLength(0)
  })

  test("hides private-channel memos from non-participants", async () => {
    const ownerClient = new TestClient()
    await loginAs(ownerClient, testEmail("owner"), "Memo Owner")
    const workspace = await createWorkspace(ownerClient, `Memo Private ${testRunId}`)
    const privateChannel = await createChannel(ownerClient, workspace.id, `memo-private-${testRunId}`, "private")
    const message = await sendMessage(ownerClient, workspace.id, privateChannel.id, "Sensitive launch timing")

    const hiddenPhrase = `private memo ${testRunId}`
    const hiddenMemoId = await insertMemo({
      pool,
      workspaceId: workspace.id,
      sourceMessageId: message.id,
      participantIds: [message.authorId],
      title: "Hidden launch memo",
      abstract: `This ${hiddenPhrase} must stay in the private channel.`,
    })

    const outsiderClient = new TestClient()
    await loginAs(outsiderClient, testEmail("outsider"), "Memo Outsider")
    await joinWorkspace(outsiderClient, workspace.id)

    const searchResponse = await outsiderClient.post<MemoSearchApiResponse>(
      `/api/workspaces/${workspace.id}/memos/search`,
      {
        query: `"${hiddenPhrase}"`,
      }
    )
    expect(searchResponse.status).toBe(200)
    expect(searchResponse.data.results).toHaveLength(0)

    const detailResponse = await outsiderClient.get(`/api/workspaces/${workspace.id}/memos/${hiddenMemoId}`)
    expect(detailResponse.status).toBe(404)
  })
})
