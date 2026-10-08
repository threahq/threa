import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import type { Pool } from "pg"
import { setupTestDatabase, withTestTransaction } from "./setup"
import { MemoRepository } from "../../src/features/memos"

const MIGRATION_PATH = resolve(import.meta.dir, "../../src/db/migrations/20261007052002_memo_superseded_by.sql")

describe("memo superseded_by migration", () => {
  let pool: Pool
  let migrationSql: string

  beforeAll(async () => {
    pool = await setupTestDatabase()
    migrationSql = await Bun.file(MIGRATION_PATH).text()
  })

  afterAll(async () => {
    await pool.end()
  })

  test("links each retired memo to the sibling whose chain still reaches an active memo", async () => {
    await withTestTransaction(pool, async (client) => {
      const memos: Array<[id: string, status: string, parentId: string | null, createdAt: string]> = [
        ["memo_mig_p1", "superseded", null, "2026-01-01"],
        ["memo_mig_active_older", "active", "memo_mig_p1", "2026-01-02"],
        ["memo_mig_superseded_newer", "superseded", "memo_mig_p1", "2026-01-04"],
        ["memo_mig_p2", "superseded", null, "2026-01-01"],
        ["memo_mig_superseded_older", "superseded", "memo_mig_p2", "2026-01-02"],
        ["memo_mig_chain_end", "active", "memo_mig_superseded_older", "2026-01-03"],
        ["memo_mig_archived_newer", "archived", "memo_mig_p2", "2026-01-04"],
      ]
      for (const [id, status, parentId, createdAt] of memos) {
        await client.query(
          `INSERT INTO memos
             (id, workspace_id, memo_type, title, abstract, status, parent_memo_id, created_at,
              source_message_ids, participant_ids, knowledge_type, source_message_id)
           VALUES ($1, 'ws_memo_mig', 'message', 't', 'a', $2, $3, $4, '{}', '{}', 'decision', 'msg_memo_mig')`,
          [id, status, parentId, createdAt]
        )
      }

      await client.query(migrationSql)

      const linked = await client.query<{ id: string; superseded_by_memo_id: string | null }>(
        `SELECT id, superseded_by_memo_id FROM memos WHERE workspace_id = 'ws_memo_mig' AND status = 'superseded'`
      )
      const successorOfP1 = await MemoRepository.findActiveSuccessor(client, "ws_memo_mig", "memo_mig_p1")
      const successorOfP2 = await MemoRepository.findActiveSuccessor(client, "ws_memo_mig", "memo_mig_p2")

      expect({
        links: Object.fromEntries(linked.rows.map((row) => [row.id, row.superseded_by_memo_id])),
        successorOfP1: successorOfP1?.id,
        successorOfP2: successorOfP2?.id,
      }).toEqual({
        links: {
          memo_mig_p1: "memo_mig_active_older",
          memo_mig_superseded_newer: null,
          memo_mig_p2: "memo_mig_superseded_older",
          memo_mig_superseded_older: "memo_mig_chain_end",
        },
        successorOfP1: "memo_mig_active_older",
        successorOfP2: "memo_mig_chain_end",
      })
    })
  })
})
