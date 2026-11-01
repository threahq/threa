import { Pool } from "pg"
import { createDatabasePool } from "../src/db"
import { createMigrator } from "../src/db/migrations"

const DEFAULT_TEST_DATABASE_URL = "postgresql://threa:threa@localhost:5455/threa_test"

export interface TestDatabaseTarget {
  connectionUrl: string
  adminUrl: string
  databaseName: string
}

/**
 * Resolve every test-database connection from the same endpoint. Local test
 * infrastructure is exposed on port 5455; CI can override the full URL.
 */
export function getTestDatabaseTarget(): TestDatabaseTarget {
  const connectionUrl = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL
  const parsed = new URL(connectionUrl)
  const databaseName = decodeURIComponent(parsed.pathname.slice(1))
  if (!databaseName) throw new Error("TEST_DATABASE_URL must include a database name")

  const admin = new URL(parsed)
  admin.pathname = "/postgres"

  return {
    connectionUrl,
    adminUrl: admin.toString(),
    databaseName,
  }
}

/** PostgreSQL does not support bind parameters for identifiers. */
export function quoteDatabaseIdentifier(databaseName: string): string {
  return `"${databaseName.replaceAll('"', '""')}"`
}

/** The URL of another database on the test server. */
export function testDatabaseUrl(databaseName: string): string {
  const url = new URL(getTestDatabaseTarget().connectionUrl)
  url.pathname = `/${databaseName}`
  return url.toString()
}

async function withAdminPool<T>(fn: (adminPool: Pool) => Promise<T>): Promise<T> {
  const adminPool = new Pool({ connectionString: getTestDatabaseTarget().adminUrl })
  try {
    return await fn(adminPool)
  } finally {
    await adminPool.end()
  }
}

export async function dropTestDatabase(databaseName: string): Promise<void> {
  await withAdminPool((adminPool) =>
    adminPool.query(`DROP DATABASE IF EXISTS ${quoteDatabaseIdentifier(databaseName)} WITH (FORCE)`)
  )
}

/** Creates a database and runs every migration on it; a failed migration drops it again. */
export async function createMigratedTestDatabase(databaseName: string): Promise<void> {
  await withAdminPool((adminPool) => adminPool.query(`CREATE DATABASE ${quoteDatabaseIdentifier(databaseName)}`))
  try {
    const pool = createDatabasePool(testDatabaseUrl(databaseName))
    try {
      await createMigrator(pool).up()
    } finally {
      await pool.end()
    }
  } catch (error) {
    try {
      await dropTestDatabase(databaseName)
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `Migrating ${databaseName} and dropping it both failed`)
    }
    throw error
  }
}

export interface WorkerDatabases {
  urls: string[]
  templateName: string
  drop: () => Promise<void>
}

/**
 * One migrated template plus a clone of it per parallel test worker, so workers
 * never share rows: test-server boot truncates its database, and many files
 * delete whole tables. Names carry a run id so concurrent runs on the shared
 * local server never collide.
 */
export async function createWorkerDatabases(count: number): Promise<WorkerDatabases> {
  const prefix = `${getTestDatabaseTarget().databaseName}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`
  const templateName = `${prefix}_template`
  const workerNames = Array.from({ length: count }, (_, index) => `${prefix}_w${index + 1}`)
  const drop = async () => {
    const results = await Promise.allSettled([...workerNames, templateName].map((name) => dropTestDatabase(name)))
    const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
    if (errors.length) throw new AggregateError(errors, "Dropping worker databases failed")
  }

  try {
    await createMigratedTestDatabase(templateName)
    await withAdminPool((adminPool) =>
      Promise.all(
        workerNames.map((name) =>
          adminPool.query(
            `CREATE DATABASE ${quoteDatabaseIdentifier(name)} TEMPLATE ${quoteDatabaseIdentifier(templateName)}`
          )
        )
      )
    )
  } catch (error) {
    await drop().catch((cleanupError) => {
      throw new AggregateError([error, cleanupError], "Creating worker databases and dropping them both failed")
    })
    throw error
  }

  return { urls: workerNames.map(testDatabaseUrl), templateName, drop }
}
