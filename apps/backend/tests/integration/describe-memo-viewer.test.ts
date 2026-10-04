import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Pool } from "pg"
import { AuthoredByKinds, MemoScopes, StreamTypes, Visibilities } from "@threahq/types"
import { computeAgentAccessSpec, memoAudienceForSpec, resolveMemoViewer } from "../../src/features/agents/researcher"
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
  let sharedScratchpadId: string
  let privateMemoId: string
  let sharedMemoId: string
  let supersededMemoId: string
  let archivedMemoId: string
  let guestUserId: string
  let guestChannelId: string
  let memberOnlyMemoId: string
  let guestReadableMemoId: string

  /** Tool deps as a turn in `invocationStreamId` gets them: scope and memo viewer both from the access spec. */
  async function describeFrom(invocationStreamId: string, memo: string): Promise<Record<string, unknown>> {
    const stream = await StreamRepository.findById(pool, testWorkspaceId, invocationStreamId)
    const accessSpec = await computeAgentAccessSpec(pool, { stream: stream!, invokingUserId: ownerId })
    const accessibleStreamIds = await SearchRepository.getAccessibleStreamsForAgent(pool, accessSpec, testWorkspaceId)
    const tool = createDescribeMemoTool({
      workspaceId: testWorkspaceId,
      accessibleStreamIds,
      invokingUserId: ownerId,
      memoViewerUserId: resolveMemoViewer(accessSpec),
      memoAudience: memoAudienceForSpec(accessSpec),
      memoExplorer: explorer,
    } as WorkspaceToolDeps)
    const { output } = await tool.config.execute({ memoId: memo }, { toolCallId: "test" })
    return JSON.parse(output)
  }

  /** Tool deps as a turn whose audience is the guest alone gets them. */
  async function describeAsGuest(memo: string): Promise<Record<string, unknown>> {
    const accessSpec = { type: "user_full_access", userId: guestUserId } as const
    const tool = createDescribeMemoTool({
      workspaceId: testWorkspaceId,
      accessibleStreamIds: await SearchRepository.getAccessibleStreamsForAgent(pool, accessSpec, testWorkspaceId),
      invokingUserId: guestUserId,
      memoViewerUserId: resolveMemoViewer(accessSpec),
      memoAudience: memoAudienceForSpec(accessSpec),
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
    sharedScratchpadId = streamId()
    privateMemoId = memoId()
    sharedMemoId = memoId()
    supersededMemoId = memoId()
    archivedMemoId = memoId()
    guestChannelId = streamId()
    memberOnlyMemoId = memoId()
    guestReadableMemoId = memoId()
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
      await StreamMemberRepository.insert(client, testWorkspaceId, publicChannelId, ownerId)

      await StreamRepository.insert(client, {
        id: ownerScratchpadId,
        workspaceId: testWorkspaceId,
        type: StreamTypes.SCRATCHPAD,
        visibility: Visibilities.PRIVATE,
        createdBy: ownerId,
      })
      await StreamMemberRepository.insert(client, testWorkspaceId, ownerScratchpadId, ownerId)

      // Joined through one of the scratchpad's threads.
      const guestId = (await addTestMember(client, testWorkspaceId, userId())).id
      await StreamRepository.insert(client, {
        id: sharedScratchpadId,
        workspaceId: testWorkspaceId,
        type: StreamTypes.SCRATCHPAD,
        visibility: Visibilities.PRIVATE,
        createdBy: ownerId,
      })
      await StreamMemberRepository.insert(client, testWorkspaceId, sharedScratchpadId, ownerId)
      await StreamMemberRepository.insert(client, testWorkspaceId, sharedScratchpadId, guestId)

      // Both memos cite a message in the public channel, so the source-stream
      // gate passes in every turn and only the memo's scope separates them.
      const sourceMessageId = messageId()
      await MessageRepository.insert(client, {
        workspaceId: testWorkspaceId,
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
      await MemoRepository.insert(client, { ...memoBase, id: supersededMemoId, title: "Superseded" })
      await MemoRepository.markSuperseded(client, testWorkspaceId, [supersededMemoId], "revised")
      await MemoRepository.insert(client, { ...memoBase, id: archivedMemoId, title: "Archived" })
      await MemoRepository.archive(client, testWorkspaceId, archivedMemoId)

      // Agent memos located in a channel the guest reads: one also drew on the
      // member-only public channel, the other only on what the guest reads.
      guestUserId = (await addTestMember(client, testWorkspaceId, userId(), "guest")).id
      await StreamRepository.insert(client, {
        id: guestChannelId,
        workspaceId: testWorkspaceId,
        type: StreamTypes.CHANNEL,
        visibility: Visibilities.GUEST_PUBLIC,
        slug: `g-${guestChannelId.slice(-8)}`,
        createdBy: ownerId,
      })
      const guestMessageId = messageId()
      await MessageRepository.insert(client, {
        workspaceId: testWorkspaceId,
        id: guestMessageId,
        streamId: guestChannelId,
        sequence: 1n,
        authorId: ownerId,
        authorType: "user",
        ...testMessageContent("guest-visible source"),
      })
      const agentMemoBase = {
        ...memoBase,
        sourceMessageId: guestMessageId,
        sourceMessageIds: [guestMessageId],
        authoredByKind: AuthoredByKinds.AGENT,
      }
      await MemoRepository.insert(client, {
        ...agentMemoBase,
        id: memberOnlyMemoId,
        title: "Drew on member-only content",
        sourceStreamIds: [guestChannelId, publicChannelId],
        requiresBrowse: true,
      })
      await MemoRepository.insert(client, {
        ...agentMemoBase,
        id: guestReadableMemoId,
        title: "Drew on guest-readable content",
        sourceStreamIds: [guestChannelId],
        requiresBrowse: false,
      })
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

  test("a turn in a private scratchpad another member can read cannot describe the private memo", async () => {
    expect(await describeFrom(sharedScratchpadId, privateMemoId)).toEqual({
      error: "Memo not found, archived, or you don't have access to its source stream",
      memoId: privateMemoId,
    })
  })

  test("a turn in a shared stream still describes workspace-scoped memos", async () => {
    expect(await describeFrom(publicChannelId, sharedMemoId)).toMatchObject({ id: sharedMemoId, title: "Shared" })
  })

  test("retired memos are not described", async () => {
    expect([
      await describeFrom(publicChannelId, supersededMemoId),
      await describeFrom(publicChannelId, archivedMemoId),
    ]).toEqual([
      { error: "Memo not found, archived, or you don't have access to its source stream", memoId: supersededMemoId },
      { error: "Memo not found, archived, or you don't have access to its source stream", memoId: archivedMemoId },
    ])
  })

  test("should describe an agent memo only when a guest audience can read its provenance", async () => {
    expect([await describeAsGuest(memberOnlyMemoId), await describeAsGuest(guestReadableMemoId)]).toEqual([
      { error: "Memo not found, archived, or you don't have access to its source stream", memoId: memberOnlyMemoId },
      expect.objectContaining({ id: guestReadableMemoId, title: "Drew on guest-readable content" }),
    ])
  })
})
