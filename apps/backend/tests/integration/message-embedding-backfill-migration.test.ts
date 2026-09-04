import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { resolve } from "node:path"
import { setupTestDatabase, withTestTransaction } from "./setup"

const MIGRATION_PATH = resolve(
  import.meta.dir,
  "../../src/db/migrations/20260904230000_backfill_message_embeddings_context.sql"
)

/**
 * A registered backfill definition is inert until a migration enqueues its
 * `backfill.plan` jobs (INV-67) — without this migration, messages embedded
 * before the context-aware embedding text landed would never be re-embedded.
 * Runs the real SQL against Postgres: the enqueue's per-workspace fan-out and
 * delay semantics can't be proven from a mock.
 */
describe("enqueue message-embeddings-context backfill migration", () => {
  let pool: Pool
  let migrationSql: string

  beforeAll(async () => {
    pool = await setupTestDatabase()
    migrationSql = await Bun.file(MIGRATION_PATH).text()
  })

  afterAll(async () => {
    await pool.end()
  })

  test("enqueues one backfill.plan job per existing workspace", async () => {
    await withTestTransaction(pool, async (client) => {
      await client.query(
        `INSERT INTO workspaces (id, name, slug, created_by)
         VALUES
           ('ws_embed_backfill_1', 'Embed Backfill 1', 'embed-backfill-1', 'usr_test'),
           ('ws_embed_backfill_2', 'Embed Backfill 2', 'embed-backfill-2', 'usr_test')`
      )

      await client.query(migrationSql)

      const enqueued = await client.query(
        `SELECT workspace_id, queue_name, payload
         FROM queue_messages
         WHERE queue_name = 'backfill.plan'
           AND payload->>'backfillName' = 'message-embeddings-context'
           AND workspace_id IN ('ws_embed_backfill_1', 'ws_embed_backfill_2')
         ORDER BY workspace_id`
      )

      expect(enqueued.rows).toEqual([
        {
          workspace_id: "ws_embed_backfill_1",
          queue_name: "backfill.plan",
          payload: { workspaceId: "ws_embed_backfill_1", backfillName: "message-embeddings-context" },
        },
        {
          workspace_id: "ws_embed_backfill_2",
          queue_name: "backfill.plan",
          payload: { workspaceId: "ws_embed_backfill_2", backfillName: "message-embeddings-context" },
        },
      ])
    })
  })

  test("delays process_after by at least 10 minutes so a rolling deploy cuts over before the job runs", async () => {
    await withTestTransaction(pool, async (client) => {
      await client.query(
        `INSERT INTO workspaces (id, name, slug, created_by)
         VALUES ('ws_embed_backfill_delay', 'Embed Backfill Delay', 'embed-backfill-delay', 'usr_test')`
      )

      await client.query(migrationSql)

      const enqueued = await client.query(
        `SELECT (process_after - now()) >= interval '10 minutes' AS delayed
         FROM queue_messages
         WHERE queue_name = 'backfill.plan'
           AND payload->>'backfillName' = 'message-embeddings-context'
           AND workspace_id = 'ws_embed_backfill_delay'`
      )

      expect(enqueued.rows[0].delayed).toBe(true)
    })
  })
})
