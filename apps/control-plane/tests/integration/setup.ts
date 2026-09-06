/**
 * Shared setup for control-plane integration tests.
 *
 * Provides a real Postgres pool against `threa_control_plane_test` with the
 * CP migrations applied. Tests use this when they need to exercise SQL paths
 * (race-safe upserts, atomic lock claims) rather than HTTP-level behavior.
 */

import path from "path"
import { Pool } from "pg"
import { createDatabasePool, runMigrations } from "@threahq/backend-common"

const ADMIN_DATABASE_URL = "postgresql://threa:threa@localhost:5454/postgres"
const TEST_DATABASE_URL = "postgresql://threa:threa@localhost:5454/threa_control_plane_test"
const MIGRATIONS_GLOB = path.resolve(import.meta.dirname, "../../src/db/migrations/*.sql")

export async function ensureTestDatabaseExists(): Promise<void> {
  const adminPool = new Pool({ connectionString: ADMIN_DATABASE_URL })
  try {
    const result = await adminPool.query("SELECT 1 FROM pg_database WHERE datname = 'threa_control_plane_test'")
    if (result.rows.length === 0) {
      await adminPool.query("CREATE DATABASE threa_control_plane_test")
    }
  } finally {
    await adminPool.end()
  }
}

export function createTestPool(): Pool {
  return createDatabasePool(process.env.TEST_DATABASE_URL ?? TEST_DATABASE_URL)
}

export async function setupTestDatabase(): Promise<Pool> {
  await ensureTestDatabaseExists()
  const pool = createTestPool()
  await runMigrations(pool, MIGRATIONS_GLOB)
  return pool
}
