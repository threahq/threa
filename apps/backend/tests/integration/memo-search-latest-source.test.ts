import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Pool } from "pg"
import { StreamTypes, Visibilities } from "@threahq/types"
import { MemoRepository, type MemoSearchResult } from "../../src/features/memos"
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

describe("MemoRepository search latestSourceAt", () => {
  let pool: Pool
  let testWorkspaceId: string
  let channelId: string
  let sourcedMemoId: string
  let sourcelessMemoId: string
  let newestSourceAt: Date

  beforeAll(async () => {
    pool = await setupTestDatabase()
    testWorkspaceId = workspaceId()
    channelId = streamId()
    sourcedMemoId = memoId()
    sourcelessMemoId = memoId()
    const workosUserId = userId()

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: testWorkspaceId,
        name: "Latest Source",
        slug: `latest-source-${testWorkspaceId}`,
        createdBy: workosUserId,
      })
      const ownerId = (await addTestMember(client, testWorkspaceId, workosUserId)).id
      await StreamRepository.insert(client, {
        id: channelId,
        workspaceId: testWorkspaceId,
        type: StreamTypes.CHANNEL,
        visibility: Visibilities.PRIVATE,
        slug: `latest-source-${channelId}`,
        createdBy: ownerId,
      })
      await StreamMemberRepository.insert(client, testWorkspaceId, channelId, ownerId)

      const postedAt = [new Date("2026-03-01T09:00:00Z"), new Date("2026-03-09T09:00:00Z")]
      const sources = await Promise.all(
        postedAt.map((createdAt, index) =>
          MessageRepository.insert(client, {
            workspaceId: testWorkspaceId,
            id: messageId(),
            streamId: channelId,
            sequence: BigInt(index + 1),
            authorId: ownerId,
            authorType: "user",
            createdAt,
            ...testMessageContent(`deploy order revision ${index}`),
          })
        )
      )
      newestSourceAt = sources[1]!.createdAt

      await MemoRepository.insert(client, {
        id: sourcedMemoId,
        workspaceId: testWorkspaceId,
        memoType: "message",
        sourceMessageId: sources[0]!.id,
        title: "Deploy order",
        abstract: "Regions deploy before the control plane.",
        keyPoints: [],
        sourceMessageIds: [sources[0]!.id, sources[1]!.id, messageId()],
        participantIds: [ownerId],
        knowledgeType: "decision",
      })
      await MemoRepository.insert(client, {
        id: sourcelessMemoId,
        workspaceId: testWorkspaceId,
        memoType: "message",
        sourceMessageId: sources[0]!.id,
        title: "Deploy order note",
        abstract: "Regions deploy first, noted by hand.",
        keyPoints: [],
        sourceMessageIds: [],
        participantIds: [ownerId],
        knowledgeType: "decision",
      })
      await MemoRepository.updateEmbedding(client, testWorkspaceId, sourcedMemoId, axis(0))
      await MemoRepository.updateEmbedding(client, testWorkspaceId, sourcelessMemoId, axis(0))
    })
  })

  afterAll(async () => {
    await pool.end()
  })

  test("every search path dates a memo by its newest resolvable source message, and null without one", async () => {
    const filters = { streamIds: [channelId] }
    const byMemo = (rows: MemoSearchResult[]) =>
      Object.fromEntries(rows.map((row) => [row.memo.id, row.latestSourceAt?.toISOString() ?? null]))

    const [browse, fullText, exact, hybrid] = await Promise.all([
      MemoRepository.fullTextSearch(pool, { workspaceId: testWorkspaceId, query: "", filters }),
      MemoRepository.fullTextSearch(pool, { workspaceId: testWorkspaceId, query: "deploy order", filters }),
      MemoRepository.exactSearch(pool, { workspaceId: testWorkspaceId, query: "deploy order", filters }),
      MemoRepository.hybridSearch(pool, {
        workspaceId: testWorkspaceId,
        query: "deploy order",
        embedding: axis(0),
        filters,
      }),
    ])

    const expected = { [sourcedMemoId]: newestSourceAt.toISOString(), [sourcelessMemoId]: null }
    expect({
      browse: byMemo(browse),
      fullText: byMemo(fullText),
      exact: byMemo(exact),
      hybrid: byMemo(hybrid),
    }).toEqual({ browse: expected, fullText: expected, exact: expected, hybrid: expected })
  })
})
