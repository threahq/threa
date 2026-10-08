/**
 * Database isolation for AI evaluations.
 *
 * Supports two modes:
 * 1. Single run: Create fresh database with migrations
 * 2. Parallel runs: Create template once, clone for each worker
 */

import { Pool } from "pg"
import { Umzug } from "umzug"
import path from "path"
import { createDatabasePool } from "../../src/db"
import type { DatabaseOptions } from "./types"
import { SIM_CLOCK_POOL_CONFIG, SimClock, assertClockMatches } from "./sim-clock"

const ADMIN_DATABASE_URL = "postgresql://threa:threa@localhost:5454/postgres"
const DATABASE_HOST = "postgresql://threa:threa@localhost:5454"

/**
 * Create a quiet migrator (no logging) for eval runs.
 */
function createQuietMigrator(pool: Pool) {
  return new Umzug({
    migrations: {
      glob: path.join(import.meta.dirname, "../../src/db/migrations/*.sql"),
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
    // No logger = quiet migrations
    logger: undefined,
  })
}

/**
 * Generate a unique database name for an eval run.
 */
const EVAL_DATABASE_PREFIX = "threa_eval_"

function generateEvalDatabaseName(label?: string): string {
  const timestamp = Date.now()
  const suffix = label ? `_${label.replace(/[^a-z0-9]/gi, "_").toLowerCase()}` : ""
  return `${EVAL_DATABASE_PREFIX}${timestamp}${suffix}`
}

/**
 * Create a fresh database for eval isolation.
 */
async function createEvalDatabase(name: string): Promise<void> {
  const adminPool = new Pool({ connectionString: ADMIN_DATABASE_URL })

  try {
    // Check if database already exists
    const result = await adminPool.query("SELECT 1 FROM pg_database WHERE datname = $1", [name])

    if (result.rows.length === 0) {
      // Use template0 for clean database
      await adminPool.query(`CREATE DATABASE "${name}" TEMPLATE template0`)
    }
  } finally {
    await adminPool.end()
  }
}

/**
 * Drop an eval database after the run.
 */
async function dropEvalDatabase(name: string): Promise<void> {
  const adminPool = new Pool({ connectionString: ADMIN_DATABASE_URL })

  try {
    // Terminate any remaining connections
    await adminPool.query(
      `
      SELECT pg_terminate_backend(pg_stat_activity.pid)
      FROM pg_stat_activity
      WHERE pg_stat_activity.datname = $1
        AND pid <> pg_backend_pid()
    `,
      [name]
    )

    // Drop the database
    await adminPool.query(`DROP DATABASE IF EXISTS "${name}"`)
  } finally {
    await adminPool.end()
  }
}

/**
 * Clone a database from a template.
 * Much faster than creating + migrating since it copies all data.
 */
async function cloneFromTemplate(templateName: string, newName: string): Promise<void> {
  const adminPool = new Pool({ connectionString: ADMIN_DATABASE_URL })

  try {
    // Must disconnect all connections from template before cloning
    await adminPool.query(
      `
      SELECT pg_terminate_backend(pg_stat_activity.pid)
      FROM pg_stat_activity
      WHERE pg_stat_activity.datname = $1
        AND pid <> pg_backend_pid()
    `,
      [templateName]
    )

    // Clone using template
    await adminPool.query(`CREATE DATABASE "${newName}" TEMPLATE "${templateName}"`)
  } finally {
    await adminPool.end()
  }
}

/**
 * Result from setting up an eval template database.
 */
export interface EvalTemplateResult {
  /** Template database name */
  templateName: string
  /** Clone a new database from this template; each clone's sim clock restarts at the template's start */
  clone: (label: string) => Promise<EvalDatabaseResult>
  /** Clean up the template database */
  cleanup: () => Promise<void>
}

/**
 * Set up a template database for parallel eval runs.
 *
 * Creates one database with migrations, then clones can be made quickly.
 * Use this when running multiple permutations in parallel.
 */
export async function setupEvalTemplate(
  label: string,
  options: Pick<DatabaseOptions, "simClock"> = {}
): Promise<EvalTemplateResult> {
  const templateName = `threa_eval_template_${Date.now()}_${label.replace(/[^a-z0-9]/gi, "_").toLowerCase()}`
  const poolConfig = options.simClock ? SIM_CLOCK_POOL_CONFIG : undefined

  // Create and migrate the template
  await createEvalDatabase(templateName)
  const templatePool = createDatabasePool(`${DATABASE_HOST}/${templateName}`, poolConfig)
  try {
    if (options.simClock) await SimClock.install(templatePool, options.simClock)
    await createQuietMigrator(templatePool).up()
  } finally {
    await templatePool.end()
  }

  let cloneCounter = 0

  return {
    templateName,
    clone: async (cloneLabel: string): Promise<EvalDatabaseResult> => {
      const cloneName = `${templateName}_${++cloneCounter}_${cloneLabel.replace(/[^a-z0-9]/gi, "_").toLowerCase()}`
      await cloneFromTemplate(templateName, cloneName)

      const connectionString = `${DATABASE_HOST}/${cloneName}`
      const pool = createDatabasePool(connectionString, poolConfig)
      const clock = options.simClock ? await SimClock.attach(pool, options.simClock) : undefined

      return {
        pool,
        databaseName: cloneName,
        connectionString,
        clock,
        cleanup: async () => {
          await pool.end()
          await dropEvalDatabase(cloneName)
        },
      }
    },
    cleanup: async () => {
      await dropEvalDatabase(templateName)
    },
  }
}

/**
 * Result from setting up an eval database.
 */
export interface EvalDatabaseResult {
  /** Database pool connected to the eval database */
  pool: Pool
  /** Database name (for cleanup) */
  databaseName: string
  connectionString: string
  /** Drives the database's `now()`; set only when the run opted into `simClock` */
  clock: SimClock | undefined
  /** Cleanup function to drop the database */
  cleanup: () => Promise<void>
}

/**
 * Set up an isolated database for eval runs: fresh, or cloned from a kept one.
 * Migrations run either way, so a kept database stays usable as code moves on.
 */
export async function setupEvalDatabase(options: DatabaseOptions = {}): Promise<EvalDatabaseResult> {
  // Cloning terminates every connection to the source, so only an eval's own kept database may be one.
  if (options.from && !options.from.startsWith(EVAL_DATABASE_PREFIX)) {
    throw new Error(`--from-db must name a kept eval database (${EVAL_DATABASE_PREFIX}…), got ${options.from}`)
  }
  const databaseName = generateEvalDatabaseName(options.label)
  if (options.from) {
    await cloneFromTemplate(options.from, databaseName)
  } else {
    await createEvalDatabase(databaseName)
  }

  const connectionString = `${DATABASE_HOST}/${databaseName}`
  const pool = createDatabasePool(connectionString, options.simClock ? SIM_CLOCK_POOL_CONFIG : undefined)

  let clock: SimClock | undefined
  try {
    if (options.from) {
      await assertClockMatches(pool, options.from, options.simClock !== undefined)
      if (options.simClock) clock = await SimClock.resume(pool)
    } else if (options.simClock) {
      clock = await SimClock.install(pool, options.simClock)
    }
    await createQuietMigrator(pool).up()
  } catch (error) {
    await pool.end()
    await dropEvalDatabase(databaseName)
    throw error
  }

  return {
    pool,
    databaseName,
    connectionString,
    clock,
    cleanup: async () => {
      await pool.end()
      if (options.keep) {
        console.log(`Kept eval database ${databaseName}`)
        return
      }
      await dropEvalDatabase(databaseName)
    },
  }
}
