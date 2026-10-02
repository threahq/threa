/**
 * Workspace scope (INV-8) of the message-embedding backfill.
 *
 * Ids are globally unique until W3, so a decoy cannot reuse an id. The decoys are
 * a workspace-B message filed under an A stream id, and a workspace-B
 * `e2e_streams` row keyed by an A stream id: a statement that drops its
 * `workspace_id` pin plans the B message, or treats A's stream as sealed.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import type { Pool } from "pg"
import { setupTestDatabase } from "./setup"
import {
  plan,
  processChunk,
  type MessageEmbeddingBackfillContext,
} from "../../src/features/memos/message-embedding-backfill"
import { StubEmbeddingService } from "../../src/features/memos"
import { messageId, streamId, userId, workspaceId } from "../../src/lib/id"

describe("message embedding backfill workspace scope (INV-8)", () => {
  let pool: Pool
  let ctx: MessageEmbeddingBackfillContext
  const embeddingService = new StubEmbeddingService()
  const embedBatch = spyOn(embeddingService, "embedBatch")

  const wsA = workspaceId()
  const wsB = workspaceId()
  const author = userId()
  let nextSequence = 1

  let channel: string
  let sealedElsewhere: string
  let inChannel: string
  let inSealedElsewhere: string
  let decoy: string

  async function addStream(ws: string) {
    const id = streamId()
    await pool.query(
      `INSERT INTO streams (id, workspace_id, type, visibility, created_by) VALUES ($1, $2, 'channel', 'public', $3)`,
      [id, ws, author]
    )
    return id
  }

  async function addMessage(ws: string, stream: string, markdown: string) {
    const id = messageId()
    await pool.query(
      `INSERT INTO messages (id, workspace_id, stream_id, sequence, author_id, author_type, content_markdown, content_json)
       VALUES ($1, $2, $3, $4, $5, 'user', $6, '{}')`,
      [id, ws, stream, nextSequence++, author, markdown]
    )
    return id
  }

  async function embeddedIds(ids: string[]) {
    const result = await pool.query<{ id: string }>(
      `SELECT id FROM messages WHERE id = ANY($1) AND embedding_source_hash IS NOT NULL ORDER BY id`,
      [ids]
    )
    return result.rows.map((row) => row.id)
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
    ctx = { pool, embeddingService }

    channel = await addStream(wsA)
    sealedElsewhere = await addStream(wsA)
    inChannel = await addMessage(wsA, channel, "an eligible message in workspace A")
    inSealedElsewhere = await addMessage(wsA, sealedElsewhere, "sealed only in workspace B's table")
    decoy = await addMessage(wsB, channel, "a workspace B message under an A stream")
    await pool.query(
      `INSERT INTO e2e_streams (stream_id, workspace_id, owner_user_id, owner_user_key_id) VALUES ($1, $2, $3, $4)`,
      [sealedElsewhere, wsB, author, "key_scope_decoy"]
    )
  })

  afterAll(async () => {
    await pool.end()
  })

  test("should plan A's messages only when B recorded a seal for an A stream", async () => {
    const chunks = await plan(ctx, wsA)

    expect(chunks).toEqual([{ ids: [inChannel, inSealedElsewhere].sort() }])
  })

  test("should embed A's messages only when the chunk names a B message", async () => {
    const result = await processChunk(ctx, wsA, { ids: [inChannel, inSealedElsewhere, decoy] })

    expect({ result, embeddedIds: await embeddedIds([inChannel, inSealedElsewhere, decoy]) }).toEqual({
      result: { processed: 2 },
      embeddedIds: [inChannel, inSealedElsewhere].sort(),
    })
    expect(embedBatch.mock.calls.flatMap(([texts]) => texts)).toHaveLength(2)
  })
})
