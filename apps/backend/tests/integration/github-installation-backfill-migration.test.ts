import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { resolve } from "node:path"
import { setupTestDatabase, withTestTransaction } from "./setup"

const MIGRATION_PATH = resolve(
  import.meta.dir,
  "../../src/db/migrations/20260717120000_enqueue_github_installation_backfill.sql"
)

/**
 * Regression: the `20260716120000` migration only added the `installation_id`
 * column; nothing enqueued the `github-installation-routes` backfill, so
 * pre-existing GitHub integrations never got their column/CP route filled. This
 * migration enqueues one `backfill.plan` job per workspace holding a github row.
 */
describe("enqueue github installation backfill migration", () => {
  let pool: Pool
  let migrationSql: string

  beforeAll(async () => {
    pool = await setupTestDatabase()
    migrationSql = await Bun.file(MIGRATION_PATH).text()
  })

  afterAll(async () => {
    await pool.end()
  })

  test("enqueues a backfill.plan job only for workspaces with a github integration", async () => {
    await withTestTransaction(pool, async (client) => {
      await client.query(
        `INSERT INTO workspace_integrations (id, workspace_id, provider, status, installed_by)
         VALUES
           ('wsi_gh1', 'ws_test_gh', 'github', 'active', 'usr_test'),
           ('wsi_slack', 'ws_test_slack', 'slack', 'active', 'usr_test')`
      )

      await client.query(migrationSql)

      const enqueued = await client.query(
        `SELECT workspace_id, queue_name, payload
         FROM queue_messages
         WHERE queue_name = 'backfill.plan'
           AND payload->>'backfillName' = 'github-installation-routes'
         ORDER BY workspace_id`
      )

      expect(enqueued.rows).toEqual([
        {
          workspace_id: "ws_test_gh",
          queue_name: "backfill.plan",
          payload: { workspaceId: "ws_test_gh", backfillName: "github-installation-routes" },
        },
      ])
    })
  })

  test("delays process_after ~10 minutes so a rolling deploy cuts over before the job runs", async () => {
    await withTestTransaction(pool, async (client) => {
      await client.query(
        `INSERT INTO workspace_integrations (id, workspace_id, provider, status, installed_by)
         VALUES ('wsi_gh_delay', 'ws_test_gh_delay', 'github', 'active', 'usr_test')`
      )

      await client.query(migrationSql)

      const enqueued = await client.query(
        `SELECT (process_after - now()) > interval '9 minutes' AS delayed
         FROM queue_messages
         WHERE queue_name = 'backfill.plan'
           AND payload->>'backfillName' = 'github-installation-routes'
           AND workspace_id = 'ws_test_gh_delay'`
      )

      expect(enqueued.rows[0].delayed).toBe(true)
    })
  })

  test("enqueues at most one job per workspace even with multiple github rows across statuses", async () => {
    await withTestTransaction(pool, async (client) => {
      await client.query(
        `INSERT INTO workspace_integrations (id, workspace_id, provider, status, installed_by)
         VALUES ('wsi_gh_inactive', 'ws_test_gh2', 'github', 'inactive', 'usr_test')`
      )

      await client.query(migrationSql)

      const enqueued = await client.query(
        `SELECT COUNT(*)::int AS n
         FROM queue_messages
         WHERE queue_name = 'backfill.plan'
           AND payload->>'backfillName' = 'github-installation-routes'
           AND workspace_id = 'ws_test_gh2'`
      )

      // Even an inactive github row gets a plan job — plan() is idempotent and
      // no-ops when the workspace has no active github integration.
      expect(enqueued.rows[0].n).toBe(1)
    })
  })
})
