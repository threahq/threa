/**
 * `StreamContextRepository`'s write statements, against a real schema.
 *
 * The conflict target here is an EXPRESSION index —
 * `(workspace_id, stream_id, category, ref_id, COALESCE(source_message_id, ''))`.
 * Postgres matches `ON CONFLICT` against it by re-deriving the expression, so a
 * clause that drifts from the index does not degrade: it raises "no unique or
 * exclusion constraint matching the ON CONFLICT specification" on the first
 * insert. A fake Querier returns a canned rowCount for the same statement and
 * reports the write as fine, which is how a renamed column and a nonexistent
 * one each reached production from a green suite.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase } from "./setup"
import { StreamContextRepository } from "../../src/features/stream-context/repository"
import type { NewStreamContextItem } from "../../src/features/stream-context/types"
import { messageId, streamContextItemId, streamId, userId, workspaceId } from "../../src/lib/id"
import { sql } from "../../src/db"

describe("stream-context repository against the real schema", () => {
  let pool: Pool

  const wsId = workspaceId()
  const channelId = streamId()
  const threadId = streamId()
  const authorId = userId()

  function row(overrides: Partial<NewStreamContextItem> = {}): NewStreamContextItem {
    return {
      id: streamContextItemId(),
      workspaceId: wsId,
      streamId: channelId,
      rootStreamId: channelId,
      category: "link",
      refKind: "url",
      refId: "https://example.com/a",
      groupKey: "https://example.com/a",
      sourceMessageId: messageId(),
      authorId,
      occurredAt: new Date("2026-07-20T10:00:00.000Z"),
      sequence: 7n,
      snippet: "hello",
      detail: { url: "https://example.com/a" },
      ...overrides,
    }
  }

  async function itemsFor(sourceMessageId: string) {
    const result = await pool.query<{ category: string; ref_id: string }>(sql`
      SELECT category, ref_id FROM stream_context_items
      WHERE workspace_id = ${wsId} AND source_message_id = ${sourceMessageId}
      ORDER BY category, ref_id
    `)
    return result.rows
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.query(sql`DELETE FROM stream_context_items WHERE workspace_id = ${wsId}`)
    await pool.end()
  })

  describe("insertMany", () => {
    test("re-inserting the same identity is a no-op, and a second message keeps its own row", async () => {
      const msgOne = messageId()
      const msgTwo = messageId()
      const first = row({ sourceMessageId: msgOne })

      const inserted = await StreamContextRepository.insertMany(pool, [first])
      const reinserted = await StreamContextRepository.insertMany(pool, [
        { ...first, id: streamContextItemId(), snippet: "different snippet" },
      ])
      const sibling = await StreamContextRepository.insertMany(pool, [row({ sourceMessageId: msgTwo })])

      expect({ inserted, reinserted, sibling }).toEqual({ inserted: 1, reinserted: 0, sibling: 1 })
    })

    test("rows with no source message collide on the COALESCE branch of the identity index", async () => {
      const landmark = row({
        category: "delegation",
        refKind: "delegation",
        refId: "deleg_1",
        groupKey: "deleg_1",
        sourceMessageId: null,
        sequence: null,
      })

      const inserted = await StreamContextRepository.insertMany(pool, [landmark])
      const reinserted = await StreamContextRepository.insertMany(pool, [{ ...landmark, id: streamContextItemId() }])

      expect({ inserted, reinserted }).toEqual({ inserted: 1, reinserted: 0 })
    })

    test("an empty batch writes nothing", async () => {
      expect(await StreamContextRepository.insertMany(pool, [])).toBe(0)
    })
  })

  describe("replaceForMessage", () => {
    test("rebuilds the message's body rows and spares its memo and thread landmarks", async () => {
      const msgId = messageId()
      await StreamContextRepository.insertMany(pool, [
        row({ sourceMessageId: msgId, refId: "https://example.com/old", groupKey: "https://example.com/old" }),
        row({
          sourceMessageId: msgId,
          category: "media",
          refKind: "attachment",
          refId: "attach_1",
          groupKey: "attach_1",
        }),
        row({ sourceMessageId: msgId, category: "memo", refKind: "memo", refId: "memo_1", groupKey: "memo_1" }),
        row({ sourceMessageId: msgId, category: "thread", refKind: "thread", refId: threadId, groupKey: threadId }),
      ])

      await StreamContextRepository.replaceForMessage(pool, wsId, msgId, [
        row({ sourceMessageId: msgId, refId: "https://example.com/new", groupKey: "https://example.com/new" }),
      ])

      expect(await itemsFor(msgId)).toEqual([
        { category: "link", ref_id: "https://example.com/new" },
        { category: "memo", ref_id: "memo_1" },
        { category: "thread", ref_id: threadId },
      ])
    })

    test("an edit that removed every artifact clears the body rows", async () => {
      const msgId = messageId()
      await StreamContextRepository.insertMany(pool, [
        row({ sourceMessageId: msgId }),
        row({ sourceMessageId: msgId, category: "memo", refKind: "memo", refId: "memo_2", groupKey: "memo_2" }),
      ])

      await StreamContextRepository.replaceForMessage(pool, wsId, msgId, [])

      expect(await itemsFor(msgId)).toEqual([{ category: "memo", ref_id: "memo_2" }])
    })
  })

  describe("reparentMessages", () => {
    test("re-homes only the moved messages and rewrites their destination sequence", async () => {
      const movedOne = messageId()
      const movedTwo = messageId()
      const stayed = messageId()
      for (const id of [movedOne, movedTwo, stayed]) {
        await StreamContextRepository.insertMany(pool, [
          row({ sourceMessageId: id, refId: `https://example.com/${id}`, groupKey: `https://example.com/${id}` }),
        ])
      }

      const updated = await StreamContextRepository.reparentMessages(
        pool,
        wsId,
        [
          { messageId: movedOne, sequence: 41n },
          { messageId: movedTwo, sequence: 42n },
        ],
        threadId,
        channelId
      )

      const result = await pool.query<{
        source_message_id: string
        stream_id: string
        root_stream_id: string
        sequence: string
      }>(sql`
        SELECT source_message_id, stream_id, root_stream_id, sequence::text AS sequence
        FROM stream_context_items
        WHERE workspace_id = ${wsId} AND source_message_id = ANY(${[movedOne, movedTwo, stayed]})
        ORDER BY source_message_id
      `)

      const byMessage = Object.fromEntries(
        result.rows.map((r) => [
          r.source_message_id,
          { streamId: r.stream_id, root: r.root_stream_id, seq: r.sequence },
        ])
      )
      expect({ updated, byMessage }).toEqual({
        updated: 2,
        byMessage: {
          [movedOne]: { streamId: threadId, root: channelId, seq: "41" },
          [movedTwo]: { streamId: threadId, root: channelId, seq: "42" },
          [stayed]: { streamId: channelId, root: channelId, seq: "7" },
        },
      })
    })

    test("a move that carried no messages writes nothing", async () => {
      expect(await StreamContextRepository.reparentMessages(pool, wsId, [], threadId, channelId)).toBe(0)
    })
  })
})
