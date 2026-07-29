/**
 * Global setup for browser E2E tests.
 *
 * Creates the test database (worktree-specific) and MinIO bucket before servers start.
 * Port allocation is handled in playwright.config.ts.
 * Uses docker exec to avoid needing pg/s3 modules at root level.
 *
 * Local: Uses docker-compose.test.yml (ports 5455/9002) to avoid dev conflicts
 * CI: Uses GitHub Actions services (ports 5454/9000)
 */
import { execFileSync, execSync, spawnSync } from "child_process"
import * as path from "path"

const isCI = !!process.env.CI

const MINIO_BUCKET = "threa-browser-test"
const DB_PORT = isCI ? 5454 : 5455
const MINIO_PORT = isCI ? 9000 : 9002

/**
 * Find a running container by name pattern.
 * Returns the full container name or null if not found.
 */
function findContainer(pattern: string): string | null {
  try {
    const result = execSync(`docker ps --format '{{.Names}}' --filter 'name=${pattern}'`, {
      encoding: "utf-8",
    }).trim()
    const containers = result.split("\n").filter(Boolean)
    return containers[0] || null
  } catch {
    return null
  }
}

/**
 * Get the container names for test infrastructure.
 * In CI, uses the container names from GitHub Actions workflow.
 * Locally, finds containers by the service name pattern from docker-compose.test.yml.
 */
function getContainerNames(): { postgres: string; minio: string } {
  if (isCI) {
    return { postgres: "postgres", minio: "minio" }
  }

  const postgres = findContainer("postgres-test")
  const minio = findContainer("minio-test")

  if (!postgres) {
    throw new Error("No postgres-test container found. Run 'bun run test:db:start' first.")
  }
  if (!minio) {
    throw new Error("No minio-test container found. Run 'bun run test:db:start' first.")
  }

  return { postgres, minio }
}

/**
 * Run SQL against the browser-test database from a spec.
 *
 * The two environments are reached differently and there is no name that works
 * in both: CI's postgres is a GitHub Actions *service* container, addressable
 * over TCP on the runner but carrying a generated docker name, while the local
 * one is a compose container on a port the dev stack doesn't use.
 */
export function runTestSql(sql: string, target: "region" | "control-plane" = "region"): void {
  const db = target === "control-plane" ? `${deriveTestDatabaseName()}_cp` : deriveTestDatabaseName()
  // argv, never a shell string: multi-line SQL through a shell reaches psql
  // with its newlines still escaped, and psql reads `\n` as a meta-command.
  const psql = ["psql", "-U", "threa", "-d", db, "-v", "ON_ERROR_STOP=1", "-c", sql]
  const [command, args, env] = isCI
    ? ([
        psql[0]!,
        ["-h", "localhost", "-p", String(DB_PORT), ...psql.slice(1)],
        { ...process.env, PGPASSWORD: "threa" },
      ] as const)
    : (["docker", ["exec", getContainerNames().postgres, ...psql], process.env] as const)

  execFileSync(command, args, { encoding: "utf-8", env })
}

/**
 * Derive a unique database name from the current directory.
 * Same logic as playwright.config.ts and setup-worktree.ts for consistency.
 */
function deriveTestDatabaseName(): string {
  const explicitName = process.env.PLAYWRIGHT_TEST_DB_NAME?.trim()
  if (explicitName) {
    return explicitName
  }

  const cwd = process.cwd()
  const dirName = path.basename(cwd)
  const sanitized = dirName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")

  return `${sanitized || "threa"}_browser_test`
}

/**
 * Start test containers from docker-compose.test.yml if not already running.
 */
function startTestContainers(): void {
  console.log("Starting test containers from docker-compose.test.yml...")

  // Start containers (will be no-op if already running)
  const result = spawnSync("docker", ["compose", "-f", "docker-compose.test.yml", "up", "-d", "--wait"], {
    encoding: "utf-8",
    stdio: "inherit",
  })

  if (result.status !== 0) {
    throw new Error("Failed to start test containers")
  }

  console.log("Test containers ready")
}

/**
 * Check if test containers are running.
 */
function areTestContainersRunning(): boolean {
  const postgres = findContainer("postgres-test")
  const minio = findContainer("minio-test")
  return postgres !== null && minio !== null
}

async function waitForPostgresReady(container: string, timeoutMs = 120000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastOutput = ""

  while (Date.now() < deadline) {
    const result = spawnSync("docker", ["exec", container, "pg_isready", "-U", "threa", "-d", "postgres"], {
      encoding: "utf-8",
    })

    if (result.status === 0) {
      return
    }

    lastOutput = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim()
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }

  throw new Error(`Postgres test container did not become ready within ${timeoutMs}ms: ${lastOutput}`)
}

async function ensureTestDatabase(dbName: string, container: string): Promise<void> {
  try {
    // Check if database exists
    const result = execSync(
      `docker exec ${container} psql -U threa -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '${dbName}'"`,
      { encoding: "utf-8" }
    ).trim()

    if (result !== "1") {
      console.log(`Creating test database: ${dbName}`)
      execSync(`docker exec ${container} psql -U threa -d postgres -c "CREATE DATABASE ${dbName}"`, {
        encoding: "utf-8",
      })
    } else {
      console.log(`Test database exists: ${dbName}`)
    }
  } catch (error) {
    // Database might already exist (race condition)
    if (String(error).includes("already exists")) {
      console.log(`Test database already exists: ${dbName}`)
    } else {
      throw error
    }
  }
}

async function ensureMinioBucket(container: string): Promise<void> {
  try {
    // Set up mc alias to point to the local minio server (inside the container, localhost:9000 is where minio listens)
    execSync(`docker exec ${container} mc alias set local http://localhost:9000 minioadmin minioadmin`, {
      encoding: "utf-8",
    })

    // Check if bucket exists using mc (MinIO client) inside the container
    const result = execSync(`docker exec ${container} mc ls local/${MINIO_BUCKET} 2>&1 || true`, {
      encoding: "utf-8",
    })

    if (result.includes("does not exist")) {
      console.log(`Creating MinIO bucket: ${MINIO_BUCKET}`)
      execSync(`docker exec ${container} mc mb local/${MINIO_BUCKET}`, { encoding: "utf-8" })
    } else {
      console.log(`MinIO bucket exists: ${MINIO_BUCKET}`)
    }
  } catch (error) {
    // Bucket might already exist
    if (String(error).includes("already") || String(error).includes("exists")) {
      console.log(`MinIO bucket already exists: ${MINIO_BUCKET}`)
    } else {
      throw error
    }
  }
}

export default async function globalSetup(): Promise<void> {
  console.log("\n=== Browser E2E Global Setup ===\n")

  // Derive worktree-specific database name
  const dbName = deriveTestDatabaseName()
  console.log(`Test database name: ${dbName}`)
  console.log(`Environment: ${isCI ? "CI" : "Local"}`)
  console.log(`Ports: postgres=${DB_PORT}, minio=${MINIO_PORT}`)

  if (isCI) {
    // In CI, database and bucket are created by the workflow before tests run
    console.log("CI environment detected - skipping local setup")
  } else {
    // Start test containers if not already running
    if (!areTestContainersRunning()) {
      startTestContainers()
    } else {
      console.log("Test containers already running")
    }

    const containers = getContainerNames()
    console.log(`Using postgres container: ${containers.postgres}`)
    console.log(`Using minio container: ${containers.minio}`)
    await waitForPostgresReady(containers.postgres)
    await ensureTestDatabase(dbName, containers.postgres)
    await ensureTestDatabase(`${dbName}_cp`, containers.postgres)
    await ensureMinioBucket(containers.minio)
  }

  console.log("=== Setup Complete ===\n")
}
