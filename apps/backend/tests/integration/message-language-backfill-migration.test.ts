import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { resolve } from "node:path"
import { setupTestDatabase, withTestTransaction } from "./setup"

const MIGRATION_PATH = resolve(import.meta.dir, "../../src/db/migrations/20260905120100_backfill_message_language.sql")

/**
 * The message-language definition is inert until a migration enqueues its
 * `backfill.plan` jobs (INV-67); without it, every message written before
 * `messages.language` existed would stay on the English stemmer forever.
 */
describe("enqueue message-language backfill migration", () => {
  let pool: Pool
  let migrationSql: string

  beforeAll(async () => {
    pool = await setupTestDatabase()
    migrationSql = await Bun.file(MIGRATION_PATH).text()
  })

  afterAll(async () => {
    await pool.end()
  })

  test("enqueues one delayed backfill.plan job per existing workspace", async () => {
    await withTestTransaction(pool, async (client) => {
      await client.query(
        `INSERT INTO workspaces (id, name, slug, created_by)
         VALUES
           ('ws_lang_backfill_1', 'Lang Backfill 1', 'lang-backfill-1', 'usr_test'),
           ('ws_lang_backfill_2', 'Lang Backfill 2', 'lang-backfill-2', 'usr_test')`
      )

      await client.query(migrationSql)

      const enqueued = await client.query(
        `SELECT workspace_id, queue_name, payload, (process_after - now()) >= interval '10 minutes' AS delayed
         FROM queue_messages
         WHERE queue_name = 'backfill.plan'
           AND payload->>'backfillName' = 'message-language'
           AND workspace_id IN ('ws_lang_backfill_1', 'ws_lang_backfill_2')
         ORDER BY workspace_id`
      )

      expect(enqueued.rows).toEqual([
        {
          workspace_id: "ws_lang_backfill_1",
          queue_name: "backfill.plan",
          payload: { workspaceId: "ws_lang_backfill_1", backfillName: "message-language" },
          delayed: true,
        },
        {
          workspace_id: "ws_lang_backfill_2",
          queue_name: "backfill.plan",
          payload: { workspaceId: "ws_lang_backfill_2", backfillName: "message-language" },
          delayed: true,
        },
      ])
    })
  })
})
