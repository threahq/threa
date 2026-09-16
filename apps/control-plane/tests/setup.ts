/**
 * Test setup - starts the server before all tests and stops it after.
 *
 * This file is loaded via bun test --preload. It:
 * 1. Starts a test server on a random port with a separate test database
 * 2. Exports the server URL for use in test files
 * 3. Cleans up the server after all tests complete
 */

import { beforeAll, afterAll, setDefaultTimeout } from "bun:test"
import { startTestServer, type TestServer } from "./test-server"
import type { MockRegionalBackend } from "./mock-regional-backend"

// Server startup can take a few seconds (DB creation + migrations)
setDefaultTimeout(30_000)

let testServer: TestServer | null = null

export function getBaseUrl(): string {
  if (!testServer) {
    throw new Error("Test server not started. Ensure setup.ts is loaded via --preload")
  }
  return testServer.url
}

export function getMockRegionalBackend(): MockRegionalBackend {
  if (!testServer) {
    throw new Error("Test server not started. Ensure setup.ts is loaded via --preload")
  }
  return testServer.mockRegionalBackend
}

beforeAll(async () => {
  testServer = await startTestServer()
  process.env.TEST_BASE_URL = testServer.url
  process.env.TEST_INTERNAL_API_KEY = testServer.internalApiKey
  console.log(`Control-plane test server started at ${testServer.url}`)
})

afterAll(async () => {
  if (testServer) {
    console.log("Stopping control-plane test server...")
    await testServer.stop()
    testServer = null
  }
})
