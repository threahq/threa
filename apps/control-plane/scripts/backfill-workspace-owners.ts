/**
 * One-shot owner backfill: assign the `owner` role to every workspace creator
 * who isn't already recorded as owner in the WorkOS mirror.
 *
 * Idempotent — running after a clean pass reports zero changes.
 *
 * Usage:
 *   bun apps/control-plane/scripts/backfill-workspace-owners.ts [--check]
 *
 * Flags:
 *   --check  Classify candidates and report intent without mutating WorkOS.
 *
 * Connects using the same env-driven config loader as the CP itself
 * (DATABASE_URL, WORKOS_API_KEY, USE_STUB_AUTH, ...).
 */

import path from "path"
import { createDatabasePool, runMigrations, StubWorkosOrgService, WorkosOrgServiceImpl } from "@threahq/backend-common"
import { loadControlPlaneConfig } from "../src/config"
import { WorkosAuthzAdminService, WorkspaceOwnerBackfill } from "../src/features/workos-authz"

const SYNTHETIC_ACTOR_ID = "system-owner-backfill"

async function main() {
  const dryRun = process.argv.includes("--check")

  const config = loadControlPlaneConfig()
  const pool = createDatabasePool(config.databaseUrl, { max: 4 })

  // Make sure the schema is up to date so a freshly cloned DB can run this
  // without first booting the CP.
  const migrationsGlob = path.join(import.meta.dirname, "../src/db/migrations/*.sql")
  await runMigrations(pool, migrationsGlob)

  const workosOrgService = config.useStubAuth ? new StubWorkosOrgService() : new WorkosOrgServiceImpl(config.workos)
  const adminService = new WorkosAuthzAdminService({ pool, workosOrgService })
  const backfill = new WorkspaceOwnerBackfill(pool, adminService, {
    workosUserId: SYNTHETIC_ACTOR_ID,
    isPlatformAdmin: true,
  })

  try {
    const result = await backfill.run({ dryRun })
    const verb = dryRun ? "would" : "did"
    console.log(
      `Owner backfill ${dryRun ? "(dry-run) " : ""}complete: ` +
        `workspacesScanned=${result.workspacesScanned} ` +
        `alreadyOwners=${result.alreadyOwners} ` +
        `${verb}Upgrade=${result.upgraded} ` +
        `${verb}NewlyAssign=${result.newlyAssigned} ` +
        `errors=${result.errors.length}`
    )
    if (result.errors.length > 0) {
      for (const err of result.errors) {
        console.error(`  - ${err.workspaceId}: ${err.error}`)
      }
      process.exit(1)
    }
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  console.error("Owner backfill failed:", err)
  process.exit(1)
})
