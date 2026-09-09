/**
 * Test server module - starts the control-plane with test configuration.
 *
 * Sets environment variables for:
 * - Separate test database (threa_control_plane_test)
 * - Random available port
 * - Stub auth enabled
 * - Mock regional backend
 */

import { createServer } from "http"
import { Pool } from "pg"
import { startMockRegionalBackend, type MockRegionalBackend } from "./mock-regional-backend"

export interface TestServer {
  url: string
  port: number
  internalApiKey: string
  mockRegionalBackend: MockRegionalBackend
  stop: () => Promise<void>
}

async function ensureTestDatabaseExists(): Promise<void> {
  const adminPool = new Pool({
    connectionString: "postgresql://threa:threa@localhost:5454/postgres",
  })

  try {
    const dbName = "threa_control_plane_test"
    const result = await adminPool.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName])
    if (result.rows.length === 0) {
      await adminPool.query(`CREATE DATABASE ${dbName}`)
    }
  } finally {
    await adminPool.end()
  }
}

async function cleanupStaleData(): Promise<void> {
  const testPool = new Pool({
    connectionString:
      process.env.TEST_DATABASE_URL || "postgresql://threa:threa@localhost:5454/threa_control_plane_test",
  })

  try {
    await testPool.query(`
      TRUNCATE
        workspace_registry,
        workspace_memberships,
        invitation_shadows,
        platform_roles
      CASCADE
    `)
  } catch {
    // Ignore errors if tables don't exist yet (first run before migrations)
  } finally {
    await testPool.end()
  }
}

async function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, () => {
      const address = server.address()
      if (address && typeof address === "object") {
        const port = address.port
        server.close(() => resolve(port))
      } else {
        reject(new Error("Could not get server address"))
      }
    })
    server.on("error", reject)
  })
}

export async function startTestServer(): Promise<TestServer> {
  await ensureTestDatabaseExists()
  await cleanupStaleData()

  const port = await findAvailablePort()
  const internalApiKey = "test-internal-key"

  // Start mock regional backend before control-plane (it needs the URL)
  const mockRegionalBackend = await startMockRegionalBackend()

  // Configure environment for test server
  process.env.FAST_SHUTDOWN = "true"
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL || "postgresql://threa:threa@localhost:5454/threa_control_plane_test"
  process.env.PORT = String(port)
  process.env.USE_STUB_AUTH = "true"
  process.env.SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || "wos_session_test"
  process.env.INTERNAL_API_KEY = internalApiKey
  process.env.REGIONS = JSON.stringify({ local: { internalUrl: mockRegionalBackend.url } })
  process.env.CORS_ALLOWED_ORIGINS = `http://localhost:${port}`
  process.env.GLOBAL_RATE_LIMIT_MAX = "10000"
  process.env.AUTH_RATE_LIMIT_MAX = "10000"
  process.env.WAITLIST_RATE_LIMIT_MAX = "10000"
  process.env.WORKSPACE_CREATION_SKIP_INVITE = "true"
  // Exercise the per-host redirectUri override code path in e2e tests.
  process.env.WORKOS_DEDICATED_REDIRECT_HOSTS = "admin.threa.io"

  // Import and start the server (must be after env vars are set)
  const { startServer } = await import("../src/server")
  const instance = await startServer()

  return {
    url: `http://localhost:${port}`,
    port,
    internalApiKey,
    mockRegionalBackend,
    stop: async () => {
      await instance.stop()
      await mockRegionalBackend.stop()
    },
  }
}
