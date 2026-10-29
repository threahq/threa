/**
 * Test setup - starts the server before all tests and stops it after.
 *
 * This file is loaded via bun test --preload. It:
 * 1. Starts a test server on a random port with a separate test database
 * 2. Exports the server URL for use in test files
 * 3. Cleans up the server after all tests complete
 */

import { beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { createDatabasePool } from "../src/db"
import { createMigrator } from "../src/db/migrations"
import { getTestDatabaseTarget, quoteDatabaseIdentifier } from "./test-database"
import { startTestServer, TestServer } from "./test-server"

let testServer: TestServer | null = null
let templatePromise: Promise<string> | undefined
let templateDatabaseName: string | undefined
let tearingDown = false

export function getIsolatedTestTemplate(): Promise<string> {
  if (tearingDown) throw new Error("Test database teardown has started")
  return (templatePromise ??= (async () => {
    const target = getTestDatabaseTarget()
    const databaseName = `threa_test_template_${crypto.randomUUID().replaceAll("-", "")}`
    const identifier = quoteDatabaseIdentifier(databaseName)
    const adminPool = new Pool({ connectionString: target.adminUrl })
    try {
      await adminPool.query(`CREATE DATABASE ${identifier}`)
      templateDatabaseName = databaseName
      const connectionUrl = new URL(target.connectionUrl)
      connectionUrl.pathname = `/${databaseName}`
      const pool = createDatabasePool(connectionUrl.toString())
      try {
        await createMigrator(pool).up()
      } finally {
        await pool.end()
      }
      return databaseName
    } catch (error) {
      if (templateDatabaseName) {
        try {
          await adminPool.query(`DROP DATABASE ${identifier} WITH (FORCE)`)
          templateDatabaseName = undefined
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "Test template initialization and cleanup failed")
        }
      }
      throw error
    } finally {
      await adminPool.end()
    }
  })())
}

async function cleanupIsolatedTestTemplate(): Promise<void> {
  if (!templatePromise) return
  await templatePromise.catch(() => {})
  if (!templateDatabaseName) return
  const adminPool = new Pool({ connectionString: getTestDatabaseTarget().adminUrl })
  try {
    await adminPool.query(`DROP DATABASE ${quoteDatabaseIdentifier(templateDatabaseName)} WITH (FORCE)`)
    templateDatabaseName = undefined
  } finally {
    await adminPool.end()
  }
}

// Export a getter for the base URL - tests should use this
export function getBaseUrl(): string {
  if (!testServer) {
    throw new Error("Test server not started. Ensure setup.ts is loaded via --preload")
  }
  return testServer.url
}

/** The running server's socket.io instance, for emits a test cannot reach through the API. */
export function getTestIo(): TestServer["io"] {
  if (!testServer) {
    throw new Error("Test server not started. Ensure setup.ts is loaded via --preload")
  }
  return testServer.io
}

// Global setup - runs once before all test files (migrations + MinIO can exceed 5s default hook time)
beforeAll(
  async () => {
    testServer = await startTestServer()
    // Set environment variable so client.ts can pick it up
    process.env.TEST_BASE_URL = testServer.url
    console.log(`Test server started at ${testServer.url}`)
  },
  { timeout: 120_000 }
)

// Global teardown - runs once after all test files
afterAll(async () => {
  tearingDown = true
  const results = await Promise.allSettled([
    (async () => {
      if (testServer) {
        console.log("Stopping test server...")
        await testServer.stop()
        testServer = null
      }
    })(),
    cleanupIsolatedTestTemplate(),
  ])
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
  if (errors.length) throw new AggregateError(errors, "Test resource teardown failed")
}, 120_000)
