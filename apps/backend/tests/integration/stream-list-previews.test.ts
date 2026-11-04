import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { StreamTypes } from "@threahq/types"
import { setupTestDatabase, withTransaction, addTestMember, testContentJson, testMessageContent } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamRepository } from "../../src/features/streams"
import { MessageRepository } from "../../src/features/messaging"
import { messageId, streamId, userId, workspaceId } from "../../src/lib/id"

describe("StreamRepository.listWithPreviews last message", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  test("should preview each stream's highest-sequence live message and none for an empty stream", async () => {
    const wsId = workspaceId()
    const ids = { tail: streamId(), moved: streamId(), deletedTail: streamId(), empty: streamId() }
    const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 12, minute))
    let owner = ""

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: wsId,
        name: "Preview WS",
        slug: `preview-${wsId}`,
        createdBy: userId(),
      })
      owner = (await addTestMember(client, wsId, userId())).id
      for (const id of Object.values(ids)) {
        await StreamRepository.insert(client, { id, workspaceId: wsId, type: StreamTypes.SCRATCHPAD, createdBy: owner })
      }

      const insert = (stream: string, sequence: number, text: string, createdAt: Date) =>
        MessageRepository.insert(client, {
          id: messageId(),
          workspaceId: wsId,
          streamId: stream,
          sequence: BigInt(sequence),
          authorId: owner,
          authorType: "user",
          createdAt,
          ...testMessageContent(text),
        })

      await insert(ids.tail, 1, "first", at(1))
      await insert(ids.tail, 2, "latest", at(2))
      // A message moved in keeps its original timestamp but lands at the tail.
      await insert(ids.moved, 1, "native", at(5))
      await insert(ids.moved, 2, "moved in", at(1))
      await insert(ids.deletedTail, 1, "kept", at(1))
      const deleted = await insert(ids.deletedTail, 2, "deleted", at(2))
      await MessageRepository.softDelete(client, wsId, deleted.id)
    })

    const streams = await StreamRepository.listWithPreviews(pool, wsId)
    const previews = Object.fromEntries(
      Object.entries(ids).map(([key, id]) => [key, streams.find((s) => s.id === id)?.lastMessagePreview])
    )

    expect(previews).toEqual({
      tail: { authorId: owner, authorType: "user", content: testContentJson("latest"), createdAt: at(2) },
      moved: { authorId: owner, authorType: "user", content: testContentJson("moved in"), createdAt: at(1) },
      deletedTail: { authorId: owner, authorType: "user", content: testContentJson("kept"), createdAt: at(1) },
      empty: null,
    })
  })
})
