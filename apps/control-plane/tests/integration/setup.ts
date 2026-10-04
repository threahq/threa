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

const DEFAULT_TEST_DATABASE_URL = "postgresql://threa:threa@localhost:5454/threa_control_plane_test"
const MIGRATIONS_GLOB = path.resolve(import.meta.dirname, "../../src/db/migrations/*.sql")

function effectiveTestDatabaseUrl(): string {
  return process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL
}

export async function ensureTestDatabaseExists(): Promise<void> {
  const url = new URL(effectiveTestDatabaseUrl())
  const databaseName = decodeURIComponent(url.pathname.slice(1))
  url.pathname = "/postgres"
  const adminPool = new Pool({ connectionString: url.toString() })
  try {
    const result = await adminPool.query("SELECT 1 FROM pg_database WHERE datname = $1", [databaseName])
    if (result.rows.length === 0) {
      await adminPool.query(`CREATE DATABASE "${databaseName.replaceAll('"', '""')}"`)
    }
  } finally {
    await adminPool.end()
  }
}

export function createTestPool(): Pool {
  return createDatabasePool(effectiveTestDatabaseUrl())
}

export async function setupTestDatabase(): Promise<Pool> {
  await ensureTestDatabaseExists()
  const pool = createTestPool()
  await runMigrations(pool, MIGRATIONS_GLOB)
  return pool
}
