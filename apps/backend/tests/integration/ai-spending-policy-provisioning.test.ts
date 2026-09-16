/**
 * Explicit AI spending enrollment for existing and new workspaces, against real
 * schemas (INV-68): the enrollment migration over pre-existing ledger rows, the
 * delayed seed enqueue (INV-67) and its backfill through the real plan/chunk
 * workers, and atomic provisioning in both workspace create paths.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import { Pool } from "pg"
import { AI_SPENDING_COVERAGE, type AISpendingPolicy } from "@threahq/types"
import { createDatabasePool } from "../../src/db"
import { createMigrator } from "../../src/db/migrations"
import {
  AI_SPENDING_POLICY_SEED_BACKFILL_NAME,
  AISpendingService,
  registerAISpendingPolicySeedBackfill,
} from "../../src/features/ai-usage"
import { UserRepository, WorkspaceService } from "../../src/features/workspaces"
import { createBackfillChunkWorker, createBackfillPlanWorker, getBackfill } from "../../src/lib/backfill"
import type { BackfillChunkJobData } from "../../src/lib/queue"
import { workspaceId } from "../../src/lib/id"
import { getTestDatabaseTarget, quoteDatabaseIdentifier } from "../test-database"

const LEDGER_MIGRATION = "20260916085917_ai_spending_ledger.sql"
const OPERATOR = "workos_user_operator"
const LIMITS = {
  agentCutoffUsd: "1",
  enrichmentCutoffUsd: "2",
  coreCutoffUsd: "3",
  embeddingCutoffUsd: "4",
  operatorCeilingUsd: "5",
}

let adminPool: Pool
let databaseName: string
let pool: Pool

/** A database migrated only up to the ledger, so the enrollment migration runs over real pre-existing rows. */
beforeAll(async () => {
  const target = getTestDatabaseTarget()
  adminPool = new Pool({ connectionString: target.adminUrl })
  databaseName = `threa_test_ai_policy_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`
  await adminPool.query(`CREATE DATABASE ${quoteDatabaseIdentifier(databaseName)}`)
  const url = new URL(target.connectionUrl)
  url.pathname = `/${databaseName}`
  pool = createDatabasePool(url.toString())
  await createMigrator(pool).up({ to: LEDGER_MIGRATION })
})

afterAll(async () => {
  await pool?.end()
  await adminPool.query(`DROP DATABASE IF EXISTS ${quoteDatabaseIdentifier(databaseName)} WITH (FORCE)`)
  await adminPool.end()
})

async function insertWorkspace(id: string): Promise<void> {
  await pool.query("INSERT INTO workspaces (id, name, slug, created_by) VALUES ($1, $2, $3, 'usr_seed')", [
    id,
    id,
    id.toLowerCase().replaceAll("_", "-"),
  ])
}

async function policyRows(ids: string[]) {
  const result = await pool.query(
    `SELECT workspace_id, version, status, agent_cutoff_usd::text, operator_ceiling_usd::text,
            coverage_profile, emergency_latched, status_changed_by, updated_by
     FROM ai_spending_policies WHERE workspace_id = ANY($1) ORDER BY workspace_id`,
    [ids]
  )
  return result.rows
}

async function runSeedBackfill(scope = "system"): Promise<void> {
  await createBackfillPlanWorker({ pool })({
    id: `job_plan_${crypto.randomUUID()}`,
    name: "backfill.plan",
    data: { workspaceId: scope, backfillName: AI_SPENDING_POLICY_SEED_BACKFILL_NAME },
  })
  const chunks = await pool.query<{ id: string; payload: BackfillChunkJobData }>(
    `DELETE FROM queue_messages
     WHERE queue_name = 'backfill.chunk' AND payload->>'backfillName' = $1
     RETURNING id, payload`,
    [AI_SPENDING_POLICY_SEED_BACKFILL_NAME]
  )
  const chunkWorker = createBackfillChunkWorker({ pool })
  for (const row of chunks.rows) {
    await chunkWorker({ id: row.id, name: "backfill.chunk", data: row.payload })
  }
}

describe("enrollment migration", () => {
  test("should keep existing ledger data, never enforce without acknowledgement, and seed unprotected when a workspace has no policy", async () => {
    await insertWorkspace("ws_mig_enabled")
    await insertWorkspace("ws_mig_disabled")
    await insertWorkspace("ws_mig_missing")
    await pool.query(
      `INSERT INTO ai_spending_policies (
         workspace_id, version, enabled, agent_cutoff_usd, enrichment_cutoff_usd, core_cutoff_usd,
         embedding_cutoff_usd, operator_ceiling_usd, emergency_latched
       ) VALUES
         ('ws_mig_enabled', 3, TRUE, 1.5, 2, 3, 4, 5, TRUE),
         ('ws_mig_disabled', 2, FALSE, 0, 0, 0, 0, 0, FALSE)`
    )
    await pool.query(
      `INSERT INTO ai_spending_periods (id, workspace_id, starts_at, ends_at, timezone, settled_usd, committed_usd)
       VALUES ('ai_period_mig', 'ws_mig_enabled', '2026-09-01Z', '2026-10-01Z', 'UTC', 0.75, 0.1)`
    )
    const periodBefore = (await pool.query("SELECT * FROM ai_spending_periods WHERE id = 'ai_period_mig'")).rows

    await createMigrator(pool).up()

    expect(await policyRows(["ws_mig_enabled", "ws_mig_disabled", "ws_mig_missing"])).toEqual([
      {
        workspace_id: "ws_mig_disabled",
        version: 2,
        status: "disabled",
        agent_cutoff_usd: "0.00000000",
        operator_ceiling_usd: "0.00000000",
        coverage_profile: null,
        emergency_latched: false,
        status_changed_by: null,
        updated_by: null,
      },
      {
        workspace_id: "ws_mig_enabled",
        version: 3,
        status: "disabled",
        agent_cutoff_usd: "1.50000000",
        operator_ceiling_usd: "5.00000000",
        coverage_profile: null,
        emergency_latched: true,
        status_changed_by: null,
        updated_by: null,
      },
      {
        workspace_id: "ws_mig_missing",
        version: 1,
        status: "unprotected",
        agent_cutoff_usd: null,
        operator_ceiling_usd: null,
        coverage_profile: null,
        emergency_latched: false,
        status_changed_by: null,
        updated_by: null,
      },
    ])
    const periodAfter = await pool.query("SELECT * FROM ai_spending_periods WHERE id = 'ai_period_mig'")
    expect(periodAfter.rows).toEqual(periodBefore)

    const enqueued = await pool.query(
      `SELECT workspace_id, payload, (process_after - NOW()) >= INTERVAL '10 minutes' AS delayed
       FROM queue_messages WHERE queue_name = 'backfill.plan' AND payload->>'backfillName' = $1`,
      [AI_SPENDING_POLICY_SEED_BACKFILL_NAME]
    )
    expect(enqueued.rows).toEqual([
      {
        workspace_id: "system",
        payload: { workspaceId: "system", backfillName: AI_SPENDING_POLICY_SEED_BACKFILL_NAME },
        delayed: true,
      },
    ])
  })
})

describe("policy seed backfill", () => {
  test("should seed only workspaces an old writer left without a policy, idempotently, through the registered workers", async () => {
    registerAISpendingPolicySeedBackfill()
    expect(getBackfill(AI_SPENDING_POLICY_SEED_BACKFILL_NAME)?.name).toBe(AI_SPENDING_POLICY_SEED_BACKFILL_NAME)

    const service = new AISpendingService({ pool })
    await insertWorkspace("ws_seed_old_writer")
    await insertWorkspace("ws_seed_enforced")
    await pool.query(
      "INSERT INTO ai_spending_policies (workspace_id, version, status) VALUES ('ws_seed_enforced', 1, 'unprotected')"
    )
    await service.setPolicy({
      workspaceId: "ws_seed_enforced",
      expectedVersion: 1,
      operatorWorkosUserId: OPERATOR,
      status: "enforced",
      coverageProfile: AI_SPENDING_COVERAGE.profile,
      limits: LIMITS,
    })
    await pool.query("UPDATE ai_spending_policies SET emergency_latched = TRUE WHERE workspace_id = 'ws_seed_enforced'")
    const seeded = ["ws_mig_enabled", "ws_mig_disabled", "ws_mig_missing", "ws_seed_enforced"]
    const protectedBefore = await policyRows(seeded)
    expect(await service.getPolicy("ws_seed_old_writer")).toBeNull()

    await runSeedBackfill()
    await runSeedBackfill()

    expect(await policyRows(seeded)).toEqual(protectedBefore)
    expect(await policyRows(["ws_seed_old_writer"])).toEqual([
      {
        workspace_id: "ws_seed_old_writer",
        version: 1,
        status: "unprotected",
        agent_cutoff_usd: null,
        operator_ceiling_usd: null,
        coverage_profile: null,
        emergency_latched: false,
        status_changed_by: null,
        updated_by: null,
      },
    ])
    const run = await pool.query(
      "SELECT workspace_id, status, total_chunks FROM backfill_runs WHERE backfill_name = $1",
      [AI_SPENDING_POLICY_SEED_BACKFILL_NAME]
    )
    expect(run.rows).toEqual([{ workspace_id: "system", status: "completed", total_chunks: 0 }])
  })

  test("should refuse a plan outside the system scope", async () => {
    await expect(runSeedBackfill("ws_seed_old_writer")).rejects.toThrow(/runs under the system scope/)
  })
})

describe("workspace provisioning", () => {
  const workspaces = () => new WorkspaceService(pool, {} as never, {} as never)

  function unprotected(id: string): AISpendingPolicy {
    return {
      workspaceId: id,
      version: 1,
      status: "unprotected",
      limits: null,
      coverageProfile: null,
      emergencyLatched: false,
      statusChangedAt: expect.any(Date),
      statusChangedBy: null,
      updatedBy: null,
    }
  }

  test("should record unprotected in the same transaction for both create paths", async () => {
    const service = new AISpendingService({ pool })
    const direct = await workspaces().createWorkspace({
      name: "Direct Spend",
      workosUserId: "workos_direct",
      email: "direct@example.com",
      userName: "Direct",
    })
    const fromControlPlane = await workspaces().createWorkspaceFromControlPlane({
      id: workspaceId(),
      name: "CP Spend",
      slug: `cp-spend-${crypto.randomUUID().slice(0, 8)}`,
      ownerWorkosUserId: "workos_cp",
      ownerEmail: "cp@example.com",
      ownerName: "CP",
    })
    expect(await service.getPolicy(direct.id)).toEqual(unprotected(direct.id))
    expect(await service.getPolicy(fromControlPlane.id)).toEqual(unprotected(fromControlPlane.id))
  })

  test("should leave no policy behind when workspace creation rolls back", async () => {
    const id = workspaceId()
    const failure = spyOn(UserRepository, "insert").mockRejectedValue(new Error("owner insert failed"))
    try {
      await expect(
        workspaces().createWorkspaceFromControlPlane({
          id,
          name: "Rolled Back",
          slug: `rolled-back-${crypto.randomUUID().slice(0, 8)}`,
          ownerWorkosUserId: "workos_rollback",
          ownerEmail: "rollback@example.com",
          ownerName: "Rollback",
        })
      ).rejects.toThrow("owner insert failed")
    } finally {
      failure.mockRestore()
    }
    expect(await new AISpendingService({ pool }).getPolicy(id)).toBeNull()
    const workspaceRows = await pool.query("SELECT id FROM workspaces WHERE id = $1", [id])
    expect(workspaceRows.rows).toEqual([])
  })

  test("should not reset a protected policy when the control plane retries creation", async () => {
    const service = new AISpendingService({ pool })
    const params = {
      id: workspaceId(),
      name: "Retry Spend",
      slug: `retry-spend-${crypto.randomUUID().slice(0, 8)}`,
      ownerWorkosUserId: "workos_retry",
      ownerEmail: "retry@example.com",
      ownerName: "Retry",
    }
    const created = await workspaces().createWorkspaceFromControlPlane(params)
    const enforced: AISpendingPolicy = await service.setPolicy({
      workspaceId: created.id,
      expectedVersion: 1,
      operatorWorkosUserId: OPERATOR,
      status: "enforced",
      coverageProfile: AI_SPENDING_COVERAGE.profile,
      limits: LIMITS,
    })

    expect(await workspaces().createWorkspaceFromControlPlane(params)).toEqual(created)
    expect(await service.getPolicy(created.id)).toEqual(enforced)
  })
})
