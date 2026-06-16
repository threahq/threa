import { Umzug } from "umzug"
import { Pool } from "pg"
import { logger } from "../logger"

// Advisory lock ID for migrations (arbitrary number, must be consistent)
const MIGRATION_LOCK_ID = 1234567890

export function createMigrator(pool: Pool, migrationsGlob: string) {
  return new Umzug({
    migrations: {
      glob: migrationsGlob,
      resolve: ({ name, path: filepath }) => ({
        name,
        up: async () => {
          const sql = await Bun.file(filepath!).text()
          await pool.query(sql)
        },
        down: async () => {
          throw new Error("Down migrations not supported")
        },
      }),
    },
    storage: {
      async executed() {
        await pool.query(`
          CREATE TABLE IF NOT EXISTS umzug_migrations (
            name VARCHAR(255) PRIMARY KEY,
            executed_at TIMESTAMPTZ DEFAULT NOW()
          )
        `)
        const result = await pool.query("SELECT name FROM umzug_migrations ORDER BY name")
        return result.rows.map((r) => r.name)
      },
      async logMigration({ name }) {
        await pool.query("INSERT INTO umzug_migrations (name) VALUES ($1)", [name])
      },
      async unlogMigration({ name }) {
        await pool.query("DELETE FROM umzug_migrations WHERE name = $1", [name])
      },
    },
    logger,
  })
}

/**
 * Run migrations with advisory lock to prevent concurrent execution
 */
export async function runMigrations(pool: Pool, migrationsGlob: string): Promise<void> {
  const maxAttempts = 30
  const retryDelayMs = 1000

  // Try to acquire advisory lock with retry
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await pool.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock($1) as acquired", [
      MIGRATION_LOCK_ID,
    ])
    const acquired = result.rows[0]?.acquired

    if (acquired) {
      try {
        logger.info("Acquired migration lock, running migrations...")
        const migrator = createMigrator(pool, migrationsGlob)
        await migrator.up()
        logger.info("Database migrations complete")
        return
      } finally {
        await pool.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID])
      }
    }

    // Lock not acquired, another process is running migrations
    if (attempt < maxAttempts) {
      logger.info(`Migration lock held by another process, waiting... (attempt ${attempt}/${maxAttempts})`)
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
    }
  }

  throw new Error(`Failed to acquire migration lock after ${maxAttempts} attempts`)
}
