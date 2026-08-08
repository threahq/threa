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
