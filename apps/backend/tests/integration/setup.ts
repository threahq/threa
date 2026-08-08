/**
 * Shared setup for integration tests.
 * Ensures the test database exists and provides connection helpers.
 */

import { Pool, type PoolClient } from "pg"
import { createDatabasePool } from "../../src/db"
import { createMigrator } from "../../src/db/migrations"
import { userId } from "../../src/lib/id"
import type { Querier } from "../../src/db"
import { UserRepository, type InsertUserParams } from "../../src/features/workspaces"
import { getTestDatabaseTarget, quoteDatabaseIdentifier } from "../test-database"

// Re-export production helpers for tests that need to persist data
export { withClient, withTransaction } from "../../src/db"

/**
 * Creates the test database if it doesn't exist.
 */
export async function ensureTestDatabaseExists(): Promise<void> {
  const { adminUrl, databaseName } = getTestDatabaseTarget()
  const adminPool = new Pool({ connectionString: adminUrl })

  try {
    const result = await adminPool.query("SELECT 1 FROM pg_database WHERE datname = $1", [databaseName])

    if (result.rows.length === 0) {
      await adminPool.query(`CREATE DATABASE ${quoteDatabaseIdentifier(databaseName)}`)
    }
  } finally {
    await adminPool.end()
  }
}

/**
 * Creates a pool connected to the test database.
 */
export function createTestPool(): Pool {
  return createDatabasePool(getTestDatabaseTarget().connectionUrl)
}

/**
 * Full setup: ensure database exists, connect, run migrations.
 * Returns the pool for use in tests.
 */
export async function setupTestDatabase(): Promise<Pool> {
  await ensureTestDatabaseExists()
  const pool = createTestPool()
  const migrator = createMigrator(pool)
  await migrator.up()
  return pool
}

export async function setupIsolatedTestDatabase(label: string): Promise<{ pool: Pool; cleanup: () => Promise<void> }> {
  const safeLabel = label
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/g, "_")
    .slice(0, 24)
  const databaseName = `threa_test_${safeLabel}_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`
  const target = getTestDatabaseTarget()
  const adminPool = new Pool({ connectionString: target.adminUrl })
  const databaseIdentifier = quoteDatabaseIdentifier(databaseName)
  let pool: Pool | null = null
  let databaseCreated = false

  try {
    await adminPool.query(`CREATE DATABASE ${databaseIdentifier}`)
    databaseCreated = true

    const connectionUrl = new URL(target.connectionUrl)
    connectionUrl.pathname = `/${databaseName}`
    pool = createDatabasePool(connectionUrl.toString())
    await createMigrator(pool).up()
  } catch (error) {
    if (pool) await pool.end()
    if (databaseCreated) await adminPool.query(`DROP DATABASE ${databaseIdentifier} WITH (FORCE)`)
    await adminPool.end()
    throw error
  }

  let cleanedUp = false
  return {
    pool,
    cleanup: async () => {
      if (cleanedUp) return
      cleanedUp = true
      await pool.end()
      await adminPool.query(`DROP DATABASE ${databaseIdentifier} WITH (FORCE)`)
      await adminPool.end()
    },
  }
}

/**
 * Test transaction wrapper that ALWAYS rolls back.
 * Use this instead of withTransaction in tests to ensure data isolation.
 *
 * Unlike the production withTransaction which commits on success,
 * this always rolls back to prevent test data pollution.
 */
export async function withTestTransaction<T>(pool: Pool, callback: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const result = await callback(client)
    // Always rollback, even on success - tests should not persist data
    await client.query("ROLLBACK")
    return result
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

/**
 * Creates a minimal ProseMirror JSON document from text.
 * Used in tests to construct contentJson field for messages.
 */
export function testContentJson(text: string) {
  return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] }
}

/**
 * Transforms a simple content string into the contentJson/contentMarkdown format
 * required by MessageRepository.insert. Use this in tests to avoid verbose JSON.
 *
 * @example
 * await MessageRepository.insert(client, {
 *   id: msgId,
 *   streamId,
 *   sequence: BigInt(1),
 *   authorId,
 *   authorType: "user",
 *   ...testMessageContent("Hello world"),
 * })
 */
export function testMessageContent(content: string) {
  return {
    contentJson: testContentJson(content),
    contentMarkdown: content,
  }
}

/**
 * Adds a workspace user with auto-generated id/slug for test convenience.
 * Wraps UserRepository.insert with sensible defaults.
 */
export async function addTestMember(
  db: Querier,
  workspaceId: string,
  workosUserId: string,
  role: InsertUserParams["role"] = "member"
) {
  const id = userId()
  const normalizedWorkosUserId = workosUserId.toLowerCase()
  return UserRepository.insert(db, {
    id,
    workspaceId,
    workosUserId,
    email: `${normalizedWorkosUserId}@test.local`,
    name: `Test ${normalizedWorkosUserId.slice(-8)}`,
    role,
    slug: `test-${id}`,
  })
}
