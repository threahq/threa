/**
 * The live embedding path's hash guard, against the real schema (INV-68):
 * unchanged text costs no model call, and a write that lost the race to a
 * newer embed throws so the queue retries against the newer text.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase, withTransaction, addTestMember, testMessageContent } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamService } from "../../src/features/streams"
import { EventService, MessageRepository, type Message } from "../../src/features/messaging"
import {
  embedMessageWithContext,
  hashEmbeddingText,
  loadMessageEmbeddingText,
} from "../../src/features/memos/message-embedding-text"
import type { EmbeddingServiceLike } from "../../src/features/memos"
import { workspaceId } from "../../src/lib/id"
import { AuthorTypes, StreamTypes, Visibilities } from "@threahq/types"

const EMBEDDING_DIM = 1536

function unitVector(index: number): number[] {
  const vector = new Array(EMBEDDING_DIM).fill(0)
  vector[index] = 1
  return vector
}

describe("embedMessageWithContext hash guard", () => {
  let pool: Pool
  const wsId = workspaceId()
  let message: Message

  async function readRow() {
    const row = await pool.query<{ embedding: string | null; embedding_source_hash: string | null }>(
      "SELECT embedding::text AS embedding, embedding_source_hash FROM messages WHERE id = $1",
      [message.id]
    )
    return row.rows[0]
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
    let ownerId = ""
    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: wsId,
        name: "Live Embedding WS",
        slug: `embed-live-ws-${wsId}`,
        createdBy: wsId,
      })
      ownerId = (await addTestMember(client, wsId, `owner-${wsId.slice(-8)}`)).id
    })
    const channel = await new StreamService(pool).create({
      workspaceId: wsId,
      type: StreamTypes.CHANNEL,
      slug: `embed-live-${wsId.slice(-8)}`,
      visibility: Visibilities.PUBLIC,
      createdBy: ownerId,
    })
    message = await new EventService(pool).createMessage({
      workspaceId: wsId,
      streamId: channel.id,
      authorId: ownerId,
      authorType: AuthorTypes.USER,
      ...testMessageContent("a message embedded once, then left alone"),
    })
  })

  afterAll(async () => {
    await pool.end()
  })

  test("should embed once and skip the model call when the same text comes around again", async () => {
    const calls: string[] = []
    const embeddingService: EmbeddingServiceLike = {
      async embed(text) {
        calls.push(text)
        return unitVector(0)
      },
      async embedBatch(texts) {
        return texts.map(() => unitVector(0))
      },
    }

    await embedMessageWithContext({ pool, embeddingService }, wsId, message)
    await embedMessageWithContext({ pool, embeddingService }, wsId, message)

    const text = await loadMessageEmbeddingText(pool, wsId, message)
    expect({ calls, row: await readRow() }).toEqual({
      calls: [text],
      row: { embedding: `[${unitVector(0).join(",")}]`, embedding_source_hash: hashEmbeddingText(text!) },
    })
  })

  test("should throw for retry when a newer embed landed while the model call was in flight", async () => {
    const embeddingService: EmbeddingServiceLike = {
      async embed() {
        await MessageRepository.updateEmbeddings(pool, [
          { id: message.id, embedding: unitVector(1), sourceHash: "newer-text", expectedSourceHash: null },
        ])
        return unitVector(2)
      },
      async embedBatch(texts) {
        return texts.map(() => unitVector(2))
      },
    }
    await pool.query("UPDATE messages SET embedding = NULL, embedding_source_hash = NULL WHERE id = $1", [message.id])

    await expect(embedMessageWithContext({ pool, embeddingService }, wsId, message)).rejects.toThrow(
      /lost to a concurrent write/
    )
    expect(await readRow()).toEqual({
      embedding: `[${unitVector(1).join(",")}]`,
      embedding_source_hash: "newer-text",
    })
  })
})
