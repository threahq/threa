import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { resolve } from "node:path"
import { setupTestDatabase, withTestTransaction } from "./setup"

const MIGRATION_PATH = resolve(
  import.meta.dir,
  "../../src/db/migrations/20260905193100_backfill_memo_attachment_search_config.sql"
)

/** A registered backfill is inert until a migration enqueues its plan jobs (INV-67). */
describe("enqueue memo/attachment-extraction search-config backfill migration", () => {
  let pool: Pool
  let migrationSql: string

  beforeAll(async () => {
    pool = await setupTestDatabase()
    migrationSql = await Bun.file(MIGRATION_PATH).text()
  })

  afterAll(async () => {
    await pool.end()
  })

  test("enqueues one delayed backfill.plan job per backfill per existing workspace", async () => {
    await withTestTransaction(pool, async (client) => {
      await client.query(
        `INSERT INTO workspaces (id, name, slug, created_by)
         VALUES
           ('ws_ma_config_1', 'MA Config 1', 'ma-config-1', 'usr_test'),
           ('ws_ma_config_2', 'MA Config 2', 'ma-config-2', 'usr_test')`
      )

      await client.query(migrationSql)

      const enqueued = await client.query(
        `SELECT workspace_id, queue_name, payload, (process_after - now()) >= interval '10 minutes' AS delayed
         FROM queue_messages
         WHERE queue_name = 'backfill.plan'
           AND payload->>'backfillName' IN ('memo-search-config', 'attachment-extraction-search-config')
           AND workspace_id IN ('ws_ma_config_1', 'ws_ma_config_2')
         ORDER BY workspace_id, payload->>'backfillName'`
      )

      expect(enqueued.rows).toEqual([
        {
          workspace_id: "ws_ma_config_1",
          queue_name: "backfill.plan",
          payload: { workspaceId: "ws_ma_config_1", backfillName: "attachment-extraction-search-config" },
          delayed: true,
        },
        {
          workspace_id: "ws_ma_config_1",
          queue_name: "backfill.plan",
          payload: { workspaceId: "ws_ma_config_1", backfillName: "memo-search-config" },
          delayed: true,
        },
        {
          workspace_id: "ws_ma_config_2",
          queue_name: "backfill.plan",
          payload: { workspaceId: "ws_ma_config_2", backfillName: "attachment-extraction-search-config" },
          delayed: true,
        },
        {
          workspace_id: "ws_ma_config_2",
          queue_name: "backfill.plan",
          payload: { workspaceId: "ws_ma_config_2", backfillName: "memo-search-config" },
          delayed: true,
        },
      ])
    })
  })
})
