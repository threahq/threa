import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Pool } from "pg"
import { MemoScopes, StreamTypes, Visibilities } from "@threahq/types"
import { computeAgentAccessSpec, resolveMemoViewer } from "../../src/features/agents/researcher"
import { createDescribeMemoTool, type WorkspaceToolDeps } from "../../src/features/agents/tools"
import { MemoExplorerService, MemoRepository, StubEmbeddingService, StubReranker } from "../../src/features/memos"
import { MessageRepository } from "../../src/features/messaging"
import { SearchRepository } from "../../src/features/search"
import { StreamMemberRepository, StreamRepository } from "../../src/features/streams"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { memoId, messageId, streamId, userId, workspaceId } from "../../src/lib/id"
import { addTestMember, setupTestDatabase, testMessageContent, withTransaction } from "./setup"

describe("describe_memo viewer", () => {
  let pool: Pool
  let explorer: MemoExplorerService
  let testWorkspaceId: string
  let ownerId: string
  let publicChannelId: string
  let ownerScratchpadId: string
  let privateMemoId: string
  let sharedMemoId: string

  /** Tool deps as a turn in `invocationStreamId` gets them: scope and memo viewer both from the access spec. */
  async function describeFrom(invocationStreamId: string, memo: string): Promise<Record<string, unknown>> {
    const stream = await StreamRepository.findById(pool, invocationStreamId)
    const accessSpec = await computeAgentAccessSpec(pool, { stream: stream!, invokingUserId: ownerId })
    const accessibleStreamIds = await SearchRepository.getAccessibleStreamsForAgent(pool, accessSpec, testWorkspaceId)
    const tool = createDescribeMemoTool({
      workspaceId: testWorkspaceId,
      accessibleStreamIds,
      invokingUserId: ownerId,
      memoViewerUserId: resolveMemoViewer(accessSpec),
      memoExplorer: explorer,
    } as WorkspaceToolDeps)
    const { output } = await tool.config.execute({ memoId: memo }, { toolCallId: "test" })
    return JSON.parse(output)
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
    explorer = new MemoExplorerService({
      pool,
      embeddingService: new StubEmbeddingService(),
      reranker: new StubReranker(),
    })
    testWorkspaceId = workspaceId()
    publicChannelId = streamId()
    ownerScratchpadId = streamId()
    privateMemoId = memoId()
    sharedMemoId = memoId()
    const ownerWorkosUserId = userId()

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: testWorkspaceId,
        name: "Describe Memo Viewer",
        slug: `describe-memo-viewer-${testWorkspaceId}`,
        createdBy: ownerWorkosUserId,
      })
      ownerId = (await addTestMember(client, testWorkspaceId, ownerWorkosUserId)).id

      await StreamRepository.insert(client, {
        id: publicChannelId,
        workspaceId: testWorkspaceId,
        type: StreamTypes.CHANNEL,
        visibility: Visibilities.PUBLIC,
        slug: `c-${publicChannelId.slice(-8)}`,
        createdBy: ownerId,
      })
      await StreamMemberRepository.insert(client, publicChannelId, ownerId)

      await StreamRepository.insert(client, {
        id: ownerScratchpadId,
        workspaceId: testWorkspaceId,
        type: StreamTypes.SCRATCHPAD,
        visibility: Visibilities.PRIVATE,
        createdBy: ownerId,
      })
      await StreamMemberRepository.insert(client, ownerScratchpadId, ownerId)

      // Both memos cite a message in the public channel, so the source-stream
      // gate passes in every turn and only the memo's scope separates them.
      const sourceMessageId = messageId()
      await MessageRepository.insert(client, {
        id: sourceMessageId,
        streamId: publicChannelId,
        sequence: 1n,
        authorId: ownerId,
        authorType: "user",
        ...testMessageContent("source"),
      })
      const memoBase = {
        workspaceId: testWorkspaceId,
        memoType: "message" as const,
        sourceMessageId,
        abstract: "abstract",
        keyPoints: [],
        sourceMessageIds: [sourceMessageId],
        participantIds: [ownerId],
        knowledgeType: "context" as const,
      }
      await MemoRepository.insert(client, {
        ...memoBase,
        id: privateMemoId,
        title: "Private to the owner",
        scope: MemoScopes.USER,
        scopeUserId: ownerId,
      })
      await MemoRepository.insert(client, { ...memoBase, id: sharedMemoId, title: "Shared" })
    })
  })

  afterAll(async () => {
    await pool.end()
  })

  test("a turn in a shared stream cannot describe the invoking user's private memo", async () => {
    expect(await describeFrom(publicChannelId, privateMemoId)).toEqual({
      error: "Memo not found, archived, or you don't have access to its source stream",
      memoId: privateMemoId,
    })
  })

  test("a turn in the owner's private scratchpad describes their private memo", async () => {
    expect(await describeFrom(ownerScratchpadId, privateMemoId)).toMatchObject({
      id: privateMemoId,
      title: "Private to the owner",
    })
  })

  test("a turn in a shared stream still describes workspace-scoped memos", async () => {
    expect(await describeFrom(publicChannelId, sharedMemoId)).toMatchObject({ id: sharedMemoId, title: "Shared" })
  })
})
