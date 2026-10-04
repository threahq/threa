import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Pool } from "pg"
import { StreamTypes, Visibilities } from "@threahq/types"
import { MemoRepository } from "../../src/features/memos"
import { MessageRepository } from "../../src/features/messaging"
import { StreamMemberRepository, StreamRepository } from "../../src/features/streams"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { memoId, messageId, streamId, userId, workspaceId } from "../../src/lib/id"
import { addTestMember, setupTestDatabase, testMessageContent, withTransaction } from "./setup"

function axis(index: number): number[] {
  const vector = new Array(1536).fill(0)
  vector[index] = 1
  return vector
}

describe("MemoRepository.hybridSearch semantic distance cutoff", () => {
  let pool: Pool
  let testWorkspaceId: string
  let scratchpadId: string
  let allergyMemoId: string

  beforeAll(async () => {
    pool = await setupTestDatabase()
    testWorkspaceId = workspaceId()
    scratchpadId = streamId()
    allergyMemoId = memoId()
    const workosUserId = userId()

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: testWorkspaceId,
        name: "Hybrid Threshold",
        slug: `hybrid-threshold-${testWorkspaceId}`,
        createdBy: workosUserId,
      })
      const ownerId = (await addTestMember(client, testWorkspaceId, workosUserId)).id
      await StreamRepository.insert(client, {
        id: scratchpadId,
        workspaceId: testWorkspaceId,
        type: StreamTypes.SCRATCHPAD,
        visibility: Visibilities.PRIVATE,
        createdBy: ownerId,
      })
      await StreamMemberRepository.insert(client, testWorkspaceId, scratchpadId, ownerId)

      const sourceMessageId = messageId()
      await MessageRepository.insert(client, {
        workspaceId: testWorkspaceId,
        id: sourceMessageId,
        streamId: scratchpadId,
        sequence: 1n,
        authorId: ownerId,
        authorType: "user",
        ...testMessageContent("source"),
      })
      await MemoRepository.insert(client, {
        id: allergyMemoId,
        workspaceId: testWorkspaceId,
        memoType: "message",
        sourceMessageId,
        title: "Severe peanut allergy",
        abstract: "Carries an EpiPen.",
        keyPoints: [],
        sourceMessageIds: [sourceMessageId],
        participantIds: [ownerId],
        knowledgeType: "context",
      })
      await MemoRepository.updateEmbedding(client, allergyMemoId, axis(0))
    })
  })

  afterAll(async () => {
    await pool.end()
  })

  test("a memo past the default cutoff with no shared words is found only when the cutoff is lifted", async () => {
    const search = (semanticDistanceThreshold?: number | null) =>
      MemoRepository.hybridSearch(pool, {
        workspaceId: testWorkspaceId,
        query: "Thai dinner menu",
        embedding: axis(1),
        filters: { streamIds: [scratchpadId] },
        semanticDistanceThreshold,
      })

    const [gated, ungated] = await Promise.all([search(), search(null)])

    expect({
      gated: gated.map((row) => row.memo.id),
      ungated: ungated.map((row) => row.memo.id),
    }).toEqual({ gated: [], ungated: [allergyMemoId] })
  })
})
