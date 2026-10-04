/**
 * Workspace scope (INV-8) of the stream-context backfill's TypeScript flow: a
 * message edited between the chunk read and the insert drops only its own rows,
 * with a workspace-B message filed under the same A stream id in the chunk.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import type { Pool } from "pg"
import { setupTestDatabase, testMessageContent } from "./setup"
import { processChunk, type StreamContextChunk } from "../../src/features/stream-context/backfill"
import { StreamContextRepository } from "../../src/features/stream-context/repository"
import { attachmentId, attachmentReferenceId, messageId, streamId, userId, workspaceId } from "../../src/lib/id"

const T1 = new Date("2026-01-01T00:00:00.000Z")
const T2 = new Date("2026-01-02T00:00:00.000Z")
const T3 = new Date("2026-02-01T00:00:00.000Z")

describe("stream-context workspace scope (INV-8)", () => {
  let pool: Pool
  let ctx: { pool: Pool }

  const wsA = workspaceId()
  const wsB = workspaceId()
  const authorA = userId()
  const authorB = userId()
  let nextSequence = 1

  const authorOf = (ws: string) => (ws === wsA ? authorA : authorB)

  async function addStream(ws: string) {
    const id = streamId()
    await pool.query(
      `INSERT INTO streams (id, workspace_id, type, visibility, created_by)
       VALUES ($1, $2, 'channel', 'public', $3)`,
      [id, ws, authorOf(ws)]
    )
    return id
  }

  async function addMessage(ws: string, stream: string, markdown: string, createdAt: Date) {
    const id = messageId()
    const content = testMessageContent(markdown)
    await pool.query(
      `INSERT INTO messages (id, workspace_id, stream_id, sequence, author_id, author_type, content_markdown, content_json, created_at)
       VALUES ($1, $2, $3, $4, $5, 'user', $6, $7, $8)`,
      [id, ws, stream, nextSequence++, authorOf(ws), content.contentMarkdown, content.contentJson, createdAt]
    )
    return id
  }

  async function addAttachment(ws: string, messageIdOrNull: string | null, mimeType: string) {
    const id = attachmentId()
    await pool.query(
      `INSERT INTO attachments (id, workspace_id, message_id, filename, mime_type, size_bytes, storage_path)
       VALUES ($1, $2, $3, $4, $5, 10, $6)`,
      [id, ws, messageIdOrNull, `${id}.bin`, mimeType, `path/${id}`]
    )
    return id
  }

  async function addReference(ws: string, attachment: string, message: string, stream: string) {
    await pool.query(
      `INSERT INTO attachment_references (id, workspace_id, attachment_id, message_id, stream_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [attachmentReferenceId(), ws, attachment, message, stream]
    )
  }

  async function contextRows(ws: string) {
    const result = await pool.query<{
      stream_id: string
      category: string
      ref_id: string
      source_message_id: string | null
      author_id: string | null
      occurred_at: Date
      detail: Record<string, unknown>
    }>(
      `SELECT stream_id, category, ref_id, source_message_id, author_id, occurred_at, detail
       FROM stream_context_items WHERE workspace_id = $1
       ORDER BY category, ref_id`,
      [ws]
    )
    return result.rows.map((row) => ({ ...row, occurred_at: row.occurred_at.toISOString() }))
  }

  const channel = (id: string, messages: string[] = []): StreamContextChunk => ({
    kind: "messages",
    streamId: id,
    rootStreamId: id,
    ids: [...messages].sort(),
  })

  let chMain: string
  let m1: string
  let m2: string
  let bMsg: string

  beforeAll(async () => {
    pool = await setupTestDatabase()
    ctx = { pool }

    chMain = await addStream(wsA)
    const urlM1 = `https://example.com/${chMain}/a`
    m1 = await addMessage(wsA, chMain, `see ${urlM1}`, T1)
    m2 = await addMessage(wsA, chMain, "contract attached", T2)
    bMsg = await addMessage(wsB, chMain, `see https://example.com/${chMain}/b`, T3)
    await addAttachment(wsA, m1, "image/png")
    const attPdf = await addAttachment(wsA, null, "application/pdf")
    await addReference(wsA, attPdf, m2, chMain)
  })

  beforeEach(async () => {
    await pool.query(`DELETE FROM stream_context_items WHERE workspace_id = ANY($1)`, [[wsA, wsB]])
  })

  afterEach(() => {
    mock.restore()
  })

  afterAll(async () => {
    await pool.end()
  })

  test("should drop the edited message's rows and keep the others when a message is edited between the read and the insert", async () => {
    const insertMany = StreamContextRepository.insertMany.bind(StreamContextRepository)
    spyOn(StreamContextRepository, "insertMany").mockImplementation(async (db, rows) => {
      const inserted = await insertMany(db, rows)
      await pool.query("UPDATE messages SET edited_at = now() WHERE id = $1", [m1])
      return inserted
    })

    try {
      const processed = await processChunk(ctx as never, wsA, channel(chMain, [m1, m2, bMsg]))

      expect({ processed, rows: (await contextRows(wsA)).map((row) => row.source_message_id) }).toEqual({
        processed: { processed: 1 },
        rows: [m2],
      })
    } finally {
      await pool.query("UPDATE messages SET edited_at = NULL WHERE id = $1", [m1])
    }
  })
})
