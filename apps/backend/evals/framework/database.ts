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

/** Queue, outbox, sync and migration state: each database's own machinery, never data to carry over. */
const INFRA_TABLES = new Set([
  "umzug_migrations",
  "eval_clock",
  "outbox",
  "outbox_listeners",
  "outbox_dead_letters",
  "queue_messages",
  "queue_tokens",
  "cron_schedules",
  "cron_ticks",
  "socket_io_attachments",
  "sync_log",
  "sync_log_retention_state",
  "sync_log_sweep_state",
  "workspace_sync_sequences",
  "backfill_runs",
  "backfill_chunks",
  "batch_operation_leases",
  "access_log",
])

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`

/**
 * Copies every data row of the eval database `sourceConnectionString` names into `target`, in one
 * transaction. Rows already present by primary key must be identical: copies only ever add rows,
 * so two databases that wrote the same key differently fail the copy rather than drop one side.
 * Both databases live on the eval Postgres server, which reaches the source over postgres_fdw.
 */
export async function copyDatabaseRows(target: Pool, sourceConnectionString: string): Promise<number> {
  const source = new URL(sourceConnectionString)
  const sourceName = decodeURIComponent(source.pathname.slice(1))
  const { rows: targetRows } = await target.query<{ name: string }>("SELECT current_database() AS name")
  for (const name of [sourceName, targetRows[0]!.name]) {
    if (!name.startsWith(EVAL_DATABASE_PREFIX)) throw new Error(`Refusing to copy rows with non-eval database ${name}`)
  }
  const server = `eval_copy_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`
  const client = await target.connect()
  try {
    await client.query("CREATE EXTENSION IF NOT EXISTS postgres_fdw")
    const { rows: portRows } = await client.query<{ port: string }>("SELECT current_setting('port') AS port")
    await client.query(
      `CREATE SERVER ${server} FOREIGN DATA WRAPPER postgres_fdw OPTIONS (host 'localhost', port '${portRows[0].port}', dbname '${sourceName}')`
    )
    await client.query(
      `CREATE USER MAPPING FOR CURRENT_USER SERVER ${server} OPTIONS (user '${decodeURIComponent(source.username)}', password '${decodeURIComponent(source.password)}')`
    )
    await client.query(`CREATE SCHEMA ${server}`)
    await client.query(`IMPORT FOREIGN SCHEMA public FROM SERVER ${server} INTO ${server}`)

    const { rows: tables } = await client.query<{ name: string; columns: string[]; key: string[] }>(`
      SELECT c.relname AS name,
        ARRAY(SELECT a.attname::text FROM pg_attribute a
              WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
              ORDER BY a.attnum) AS columns,
        ARRAY(SELECT a.attname::text FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
              WHERE i.indrelid = c.oid AND i.indisprimary ORDER BY a.attnum) AS key
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
      ORDER BY c.relname
    `)

    await client.query("BEGIN")
    let copied = 0
    for (const table of tables) {
      if (INFRA_TABLES.has(table.name) || table.name === "message_link_previews") continue
      const local = `public.${ident(table.name)}`
      const remote = `${server}.${ident(table.name)}`
      if (table.key.length === 0) {
        const { rows } = await client.query(`SELECT 1 FROM ${remote} LIMIT 1`)
        if (rows.length > 0) throw new Error(`Cannot copy ${table.name}: it has rows and no primary key`)
        continue
      }
      const sameKey = table.key.map((column) => `p.${ident(column)} = s.${ident(column)}`).join(" AND ")
      const row = (alias: string) =>
        `ROW(${table.columns.map((column) => `${alias}.${ident(column)}`).join(", ")})::text`
      const { rows: differing } = await client.query<{ count: string }>(
        `SELECT count(*) FROM ${remote} s JOIN ${local} p ON ${sameKey} WHERE ${row("s")} IS DISTINCT FROM ${row("p")}`
      )
      if (Number(differing[0].count) > 0) {
        throw new Error(`Cannot copy ${table.name}: ${differing[0].count} rows share a key with different contents`)
      }
      const columns = table.columns.map(ident).join(", ")
      // Each database mints its own id for a URL, and a workspace previews a URL once: the first copied wins.
      const sameUrl =
        table.name === "link_previews"
          ? " OR (p.workspace_id = s.workspace_id AND p.normalized_url = s.normalized_url)"
          : ""
      const inserted = await client.query(
        `INSERT INTO ${local} (${columns}) SELECT ${table.columns.map((column) => `s.${ident(column)}`).join(", ")}
         FROM ${remote} s WHERE NOT EXISTS (SELECT 1 FROM ${local} p WHERE ${sameKey}${sameUrl})`
      )
      copied += inserted.rowCount ?? 0
    }
    const links = await client.query(
      `INSERT INTO public.message_link_previews (workspace_id, message_id, link_preview_id, position)
       SELECT m.workspace_id, m.message_id, p.id, m.position
       FROM ${server}.message_link_previews m
       JOIN ${server}.link_previews s ON s.workspace_id = m.workspace_id AND s.id = m.link_preview_id
       JOIN public.link_previews p ON p.workspace_id = s.workspace_id AND p.normalized_url = s.normalized_url
       ON CONFLICT DO NOTHING`
    )
    copied += links.rowCount ?? 0
    await client.query("COMMIT")
    return copied
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${server} CASCADE; DROP SERVER IF EXISTS ${server} CASCADE`)
    } finally {
      client.release()
    }
  }
}
