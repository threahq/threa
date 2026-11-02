/**
 * Test setup - starts the server before all tests and stops it after.
 *
 * This file is loaded via bun test --preload. It:
 * 1. Starts a test server on a random port with a separate test database
 * 2. Exports the server URL for use in test files
 * 3. Cleans up the server after all tests complete
 */

import { beforeAll, afterAll } from "bun:test"
import { createMigratedTestDatabase, dropTestDatabase } from "./test-database"
import { startTestServer, TestServer } from "./test-server"

let testServer: TestServer | null = null
let templatePromise: Promise<string> | undefined
let ownedTemplateName: string | undefined
const liveClones = new Set<string>()
let tearingDown = false

/** A migrated template to clone isolated databases from: the parallel runner's shared one, else one per process. */
export function getIsolatedTestTemplate(): Promise<string> {
  if (tearingDown) throw new Error("Test database teardown has started")
  return (templatePromise ??= (async () => {
    const shared = process.env.THREA_TEST_TEMPLATE_DATABASE
    if (shared) return shared
    const databaseName = `threa_test_template_${crypto.randomUUID().replaceAll("-", "")}`
    await createMigratedTestDatabase(databaseName)
    ownedTemplateName = databaseName
    return databaseName
  })())
}

/** Registers a clone for the teardown sweep; the returned function deregisters it once its owner dropped it. */
export function trackIsolatedTestDatabase(databaseName: string): () => void {
  liveClones.add(databaseName)
  return () => liveClones.delete(databaseName)
}

async function cleanupIsolatedTestTemplate(): Promise<void> {
  if (!templatePromise) return
  await templatePromise.catch(() => {})
  if (!ownedTemplateName) return
  await dropTestDatabase(ownedTemplateName)
  ownedTemplateName = undefined
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
    ...[...liveClones].map((name) => dropTestDatabase(name)),
  ])
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
  if (errors.length) throw new AggregateError(errors, "Test resource teardown failed")
}, 120_000)
