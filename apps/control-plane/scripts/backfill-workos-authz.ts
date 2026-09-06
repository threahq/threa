/**
 * Re-runnable WorkOS authz backfill.
 *
 * Reads workspace_registry.workos_organization_id rows, asks WorkOS for each
 * org's full membership list, and upserts every membership into
 * workos_organization_memberships. Idempotent. Stamps
 * workos_event_poller_state.last_backfill_at so first-boot logic in
 * server.ts knows backfill has happened at least once.
 *
 * Usage:
 *   bun apps/control-plane/scripts/backfill-workos-authz.ts
 *
 * Connects using the same env-driven config loader as the CP itself
 * (DATABASE_URL, WORKOS_API_KEY, USE_STUB_AUTH, ...).
 */

import { createDatabasePool, runMigrations, WorkosOrgServiceImpl, StubWorkosOrgService } from "@threahq/backend-common"
import path from "path"
import { loadControlPlaneConfig } from "../src/config"
import { WorkosAuthzBackfill, WORKOS_EVENT_POLLER_NAME } from "../src/features/workos-authz"
import { WorkosEventPollerLock } from "../src/lib/workos-event-poller-lock"

async function main() {
  const config = loadControlPlaneConfig()
  const pool = createDatabasePool(config.databaseUrl, { max: 4 })

  // Make sure the schema is up to date so a freshly cloned DB can run this
  // without first booting the CP.
  const migrationsGlob = path.join(import.meta.dirname, "../src/db/migrations/*.sql")
  await runMigrations(pool, migrationsGlob)

  const workosOrgService = config.useStubAuth ? new StubWorkosOrgService() : new WorkosOrgServiceImpl(config.workos)

  const lock = new WorkosEventPollerLock({
    pool,
    name: WORKOS_EVENT_POLLER_NAME,
    lockDurationMs: 10_000,
    refreshIntervalMs: 5_000,
    maxRetries: 5,
    baseBackoffMs: 1_000,
  })
  await lock.ensureRow()

  const backfill = new WorkosAuthzBackfill({ pool, workosOrgService, lock })

  try {
    const result = await backfill.run()
    console.log(
      `Backfill complete: orgsScanned=${result.orgsScanned} membershipsUpserted=${result.membershipsUpserted} membershipsRemoved=${result.membershipsRemoved}`
    )
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  console.error("Backfill failed:", err)
  process.exit(1)
})
