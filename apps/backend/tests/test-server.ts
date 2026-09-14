/**
 * Test server module - starts the backend with test configuration.
 *
 * Sets environment variables for:
 * - Separate test database (threa_test)
 * - Random available port
 * - Stub auth enabled
 * - S3/MinIO configuration
 *
 * Then starts the normal server with those settings.
 */

import { createServer } from "http"
import { Pool } from "pg"
import { S3Client, HeadBucketCommand, CreateBucketCommand } from "@aws-sdk/client-s3"
import { getTestDatabaseTarget, quoteDatabaseIdentifier } from "./test-database"

export interface TestServer {
  url: string
  port: number
  stop: () => Promise<void>
}

/**
 * Creates the test database if it doesn't exist.
 */
async function ensureTestDatabaseExists(): Promise<void> {
  const { adminUrl, databaseName } = getTestDatabaseTarget()
  const adminPool = new Pool({ connectionString: adminUrl })

  try {
    const result = await adminPool.query("SELECT 1 FROM pg_database WHERE datname = $1", [databaseName])

    if (result.rows.length === 0) {
      await adminPool.query(`CREATE DATABASE ${quoteDatabaseIdentifier(databaseName)}`)
    }
  } finally {
    await adminPool.end()
  }
}

/**
 * Ensures the MinIO bucket exists for file upload tests.
 */
async function ensureMinioBucketExists(): Promise<void> {
  const bucket = process.env.S3_BUCKET || "threa-test-uploads"
  const endpoint = process.env.S3_ENDPOINT || "http://localhost:9002"

  const client = new S3Client({
    region: "us-east-1",
    endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID || "minioadmin",
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || "minioadmin",
    },
  })

  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }))
  } catch (err: unknown) {
    const error = err as { name?: string }
    if (error.name === "NotFound" || error.name === "NoSuchBucket") {
      await client.send(new CreateBucketCommand({ Bucket: bucket }))
      console.log(`Created MinIO bucket: ${bucket}`)
    } else {
      throw err
    }
  } finally {
    client.destroy()
  }
}

/**
 * Empties the mutable tables so a run never sees the previous run's rows. Runs
 * before migrations, so only tables that already exist are truncated; a fresh
 * database has nothing to clean.
 */
const MUTABLE_TABLES = [
  "outbox",
  "outbox_listeners",
  "stream_events",
  "stream_members",
  "streams",
  "workspaces",
  "users",
  "messages",
  "reactions",
  "conversations",
  "memos",
  "attachments",
  "agent_sessions",
  "agent_session_steps",
  "emoji_usage",
  "ai_usage_records",
  "ai_budgets",
  "queue_messages",
  "queue_tokens",
  "user_activity",
  "bots",
  "calls",
  "call_participants",
  "call_endpoints",
  "call_invitations",
  "call_transport_policy_states",
  "call_transport_transfers",
  "call_transport_sessions",
  "call_transfer_obligations",
]

async function cleanupStaleData(): Promise<void> {
  const testPool = new Pool({ connectionString: getTestDatabaseTarget().connectionUrl })
  try {
    const existing = await testPool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [MUTABLE_TABLES]
    )
    if (existing.rows.length > 0)
      await testPool.query(
        `TRUNCATE ${existing.rows.map((row) => quoteDatabaseIdentifier(row.table_name)).join(", ")} CASCADE`
      )
  } finally {
    await testPool.end()
  }
}

/**
 * Finds a random available port.
 */
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

/**
 * Starts a test server with isolated configuration.
 */
export async function startTestServer(): Promise<TestServer> {
  await ensureTestDatabaseExists()
  await cleanupStaleData()

  const port = await findAvailablePort()

  // Configure environment for test server
  process.env.FAST_SHUTDOWN = "true" // Fast shutdown for tests
  process.env.DATABASE_URL = getTestDatabaseTarget().connectionUrl
  process.env.PORT = String(port)
  process.env.USE_STUB_AUTH = "true"
  process.env.SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || "wos_session_test"
  process.env.USE_STUB_COMPANION = "true"
  process.env.USE_STUB_BOUNDARY_EXTRACTION = "true"
  process.env.USE_STUB_AI = "true"

  // Enable internal API endpoints (control-plane → regional backend pattern)
  process.env.INTERNAL_API_KEY = "test-internal-key"

  // Disable rate limits for tests (prevent flaky 429s)
  process.env.GLOBAL_RATE_LIMIT_MAX = "10000"
  process.env.AUTH_RATE_LIMIT_MAX = "10000"

  // Call tests drive every sweep themselves; a 15 s background sweeper would
  // race their hand-built call states (rollout_safety transfers mid-assert).
  process.env.CALL_SWEEP_INTERVAL_MS = String(60 * 60 * 1000)

  // CORS: allow test origin
  process.env.CORS_ALLOWED_ORIGINS = `http://localhost:${port},http://127.0.0.1:${port}`

  // Higher throughput for parallel test files
  process.env.QUEUE_MAX_ACTIVE_TOKENS = "15"
  process.env.QUEUE_POLL_INTERVAL_MS = "100"
  process.env.DATABASE_POOL_MAX = "50"
  // Starvation guard: a long e2e run fills the DB-backed queue; light/heavy work
  // (memo.batch-process, etc.) can otherwise delay persona.agent and boundary.extract.
  process.env.QUEUE_INTERACTIVE_TOKENS = "12"
  process.env.QUEUE_LIGHT_TOKENS = "10"
  process.env.QUEUE_HEAVY_TOKENS = "5"

  // S3/MinIO for e2e
  // - CI (`.github/workflows/ci.yml`) exports MinIO on :9000 — must not override.
  // - Local tests: Bun loads `.env` with real AWS; force docker-compose.test.yml MinIO (:9002).
  if (process.env.CI) {
    process.env.S3_BUCKET = process.env.S3_BUCKET || "threa-test-uploads"
    process.env.S3_REGION = process.env.S3_REGION || "us-east-1"
    process.env.S3_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID || "minioadmin"
    process.env.S3_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY || "minioadmin"
    process.env.S3_ENDPOINT = process.env.S3_ENDPOINT || "http://localhost:9000"
  } else {
    process.env.S3_BUCKET = "threa-test-uploads"
    process.env.S3_REGION = "us-east-1"
    process.env.S3_ACCESS_KEY_ID = "minioadmin"
    process.env.S3_SECRET_ACCESS_KEY = "minioadmin"
    process.env.S3_ENDPOINT = "http://localhost:9002"
  }

  // Ensure MinIO bucket exists
  await ensureMinioBucketExists()

  // Import and start the server (must be after env vars are set)
  const { startServer } = await import("../src/server")
  const instance = await startServer()

  return {
    url: `http://localhost:${port}`,
    port,
    stop: instance.stop,
  }
}
