/**
 * Test setup - starts the server before all tests and stops it after.
 *
 * This file is loaded via bun test --preload. It:
 * 1. Starts a test server on a random port with a separate test database
 * 2. Exports the server URL for use in test files
 * 3. Cleans up the server after all tests complete
 */

import { beforeAll, afterAll } from "bun:test"
import { startTestServer, TestServer } from "./test-server"

let testServer: TestServer | null = null

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
// Fast shutdown mode enables immediate shutdown, so no long timeout needed
afterAll(async () => {
  if (testServer) {
    console.log("Stopping test server...")
    await testServer.stop()
    testServer = null
  }
})
