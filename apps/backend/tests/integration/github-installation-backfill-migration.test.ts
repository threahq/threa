import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { resolve } from "node:path"
import { setupTestDatabase, withTestTransaction } from "./setup"
import { WorkspaceIntegrationRepository } from "../../src/features/workspace-integrations/repository"

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

/**
 * Regression (Sol review round 3 on #1374, finding #2): a status-only guard let a
 * stale backfill/deactivation clobber a row that disconnected + reconnected to a
 * DIFFERENT installation B. `update` gains `expectedInstallationId: {value, allowNull}`.
 * Exercises the real Postgres predicate — a mock can't prove the WHERE actually gates.
 */
describe("workspace_integrations installation_id guard", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  async function seed(client: Pool | import("pg").PoolClient, installationId: string | null): Promise<void> {
    await client.query(
      `INSERT INTO workspace_integrations (id, workspace_id, provider, status, installed_by, installation_id)
       VALUES ('wsi_guard', 'ws_guard', 'github', 'active', 'usr_test', $1)`,
      [installationId]
    )
  }

  test("allowNull=true (backfill) matches a NULL column and fills it", async () => {
    await withTestTransaction(pool, async (client) => {
      await seed(client, null)

      const updated = await WorkspaceIntegrationRepository.update(
        client,
        "ws_guard",
        "github",
        { installationId: "A" },
        { expectedStatus: "active", expectedInstallationId: { value: "A", allowNull: true } }
      )

      expect(updated?.installationId).toBe("A")
    })
  })

  test("allowNull=true (backfill) matches when the column already equals the value", async () => {
    await withTestTransaction(pool, async (client) => {
      await seed(client, "A")

      const updated = await WorkspaceIntegrationRepository.update(
        client,
        "ws_guard",
        "github",
        { installationId: "A" },
        { expectedStatus: "active", expectedInstallationId: { value: "A", allowNull: true } }
      )

      expect(updated?.installationId).toBe("A")
    })
  })

  test("allowNull=true (backfill) does NOT match a row reinstalled to B — no clobber to A", async () => {
    await withTestTransaction(pool, async (client) => {
      await seed(client, "B")

      const updated = await WorkspaceIntegrationRepository.update(
        client,
        "ws_guard",
        "github",
        { installationId: "A" },
        { expectedStatus: "active", expectedInstallationId: { value: "A", allowNull: true } }
      )

      expect(updated).toBeNull()
      const { rows } = await client.query(`SELECT installation_id FROM workspace_integrations WHERE id = 'wsi_guard'`)
      expect(rows[0].installation_id).toBe("B")
    })
  })

  test("allowNull=false (deactivate) matches only the exact installation id", async () => {
    await withTestTransaction(pool, async (client) => {
      await seed(client, "A")

      const updated = await WorkspaceIntegrationRepository.update(
        client,
        "ws_guard",
        "github",
        { status: "inactive" },
        { expectedStatus: "active", expectedInstallationId: { value: "A", allowNull: false } }
      )

      expect(updated?.status).toBe("inactive")
    })
  })

  test("allowNull=false (deactivate) does NOT deactivate a row now on B", async () => {
    await withTestTransaction(pool, async (client) => {
      await seed(client, "B")

      const updated = await WorkspaceIntegrationRepository.update(
        client,
        "ws_guard",
        "github",
        { status: "inactive" },
        { expectedStatus: "active", expectedInstallationId: { value: "A", allowNull: false } }
      )

      expect(updated).toBeNull()
      const { rows } = await client.query(`SELECT status FROM workspace_integrations WHERE id = 'wsi_guard'`)
      expect(rows[0].status).toBe("active")
    })
  })

  test("allowNull=false (deactivate) does NOT match a NULL column", async () => {
    await withTestTransaction(pool, async (client) => {
      await seed(client, null)

      const updated = await WorkspaceIntegrationRepository.update(
        client,
        "ws_guard",
        "github",
        { status: "inactive" },
        { expectedStatus: "active", expectedInstallationId: { value: "A", allowNull: false } }
      )

      expect(updated).toBeNull()
    })
  })
})
