import { $ } from "bun"
import * as fs from "fs"
import * as path from "path"
import * as net from "net"

const TEST_DB_NAME = "threa_test"
const TEST_CP_DB_NAME = "threa_test_cp"

/**
 * Find an available port by attempting to bind to port 0 (OS assigns random available port)
 */
async function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on("error", reject)
    server.listen(0, () => {
      const addr = server.address()
      if (addr && typeof addr === "object") {
        const port = addr.port
        server.close(() => resolve(port))
      } else {
        server.close(() => reject(new Error("Could not get port")))
      }
    })
  })
}

async function findPostgresContainer(): Promise<string | null> {
  const result = await $`docker ps --format '{{.Names}}' --filter 'name=threa-postgres'`.quiet().nothrow()
  const containers = result.stdout.toString().trim().split("\n").filter(Boolean)
  return containers[0] || null
}

async function createTestDatabase(): Promise<void> {
  console.log(`Checking if test database '${TEST_DB_NAME}' exists...`)

  const container = await findPostgresContainer()
  if (!container) {
    throw new Error("No running postgres container found. Run 'bun run db:start' first to start the database.")
  }

  console.log(`Using postgres container: ${container}`)

  // Check if database exists
  const checkResult =
    await $`docker exec ${container} psql -U threa -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${TEST_DB_NAME}'"`
      .quiet()
      .nothrow()

  if (checkResult.stdout.toString().trim() === "1") {
    console.log(`Test database '${TEST_DB_NAME}' already exists`)
  } else {
    console.log(`Creating test database '${TEST_DB_NAME}'...`)
    await $`docker exec ${container} psql -U threa -d postgres -c "CREATE DATABASE ${TEST_DB_NAME}"`
    console.log(`Test database '${TEST_DB_NAME}' created`)
  }
}

async function main() {
  try {
    // Create test database if it doesn't exist
    await createTestDatabase()

    // Create control-plane test database if needed
    const cpContainer = await findPostgresContainer()
    if (cpContainer) {
      const cpCheck =
        await $`docker exec ${cpContainer} psql -U threa -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${TEST_CP_DB_NAME}'"`
          .quiet()
          .nothrow()
      if (cpCheck.stdout.toString().trim() !== "1") {
        console.log(`Creating control-plane test database '${TEST_CP_DB_NAME}'...`)
        await $`docker exec ${cpContainer} psql -U threa -d postgres -c "CREATE DATABASE ${TEST_CP_DB_NAME}"`
        console.log(`Control-plane test database '${TEST_CP_DB_NAME}' created`)
      }
    }

    // Ports default to OS-assigned (random). Each can be pinned via an env
    // override so a test harness can spin the stack up at a known URL without
    // having to parse stdout.
    const envPort = (name: string): number | undefined => {
      const raw = process.env[name]
      if (!raw) return undefined
      const parsed = parseInt(raw, 10)
      if (Number.isNaN(parsed)) return undefined
      return parsed
    }
    const backendPort = envPort("DEV_TEST_BACKEND_PORT") ?? (await findAvailablePort())
    const controlPlanePort = envPort("DEV_TEST_CONTROL_PLANE_PORT") ?? (await findAvailablePort())
    const routerPort = envPort("DEV_TEST_ROUTER_PORT") ?? (await findAvailablePort())
    const frontendPort = envPort("DEV_TEST_FRONTEND_PORT") ?? (await findAvailablePort())
    const backofficeRouterPort = envPort("DEV_TEST_BACKOFFICE_ROUTER_PORT") ?? (await findAvailablePort())
    const backofficePort = envPort("DEV_TEST_BACKOFFICE_PORT") ?? (await findAvailablePort())

    // Load backend .env file explicitly (Bun only auto-loads from CWD)
    const backendEnvPath = path.join(process.cwd(), "apps/backend/.env")
    let backendEnv: Record<string, string> = {}

    if (fs.existsSync(backendEnvPath)) {
      const envContent = fs.readFileSync(backendEnvPath, "utf-8")
      for (const line of envContent.split("\n")) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith("#")) continue
        const [key, ...valueParts] = trimmed.split("=")
        if (key && valueParts.length > 0) {
          backendEnv[key] = valueParts.join("=")
        }
      }
    }

    // Shared CORS list — the frontend, the backoffice, and both routers all need
    // to be allowed to hit the control-plane (and the backend).
    const corsOrigins = [
      `http://localhost:${frontendPort}`,
      `http://127.0.0.1:${frontendPort}`,
      `http://localhost:${backofficePort}`,
      `http://127.0.0.1:${backofficePort}`,
      `http://localhost:${backofficeRouterPort}`,
      `http://localhost:${routerPort}`,
    ].join(",")

    // Set environment variables for test mode (backend)
    const backendEnvVars = {
      ...backendEnv, // Load from apps/backend/.env
      ...process.env, // Override with process env
      DATABASE_URL: `postgresql://threa:threa@localhost:5454/${TEST_DB_NAME}`,
      USE_STUB_AUTH: "true",
      WORKSPACE_CREATION_SKIP_INVITE: "true",
      FAST_SHUTDOWN: "true",
      PORT: String(backendPort),
      CORS_ALLOWED_ORIGINS: corsOrigins,
      CONTROL_PLANE_URL: `http://localhost:${controlPlanePort}`,
      INTERNAL_API_KEY: backendEnv.INTERNAL_API_KEY ?? "dev-internal-key",
      REGION: "local",
    }

    // Dev convenience: auto-seed a platform admin for the stub "admin@threa.io"
    // user so the backoffice works immediately after signing in. Stub user IDs
    // are deterministic: `workos_test_${base64url(email)}`.
    const devPlatformAdminEmail = "admin@threa.io"
    const devPlatformAdminId = `workos_test_${Buffer.from(devPlatformAdminEmail).toString("base64url")}`

    // Set environment variables for control-plane
    const controlPlaneEnvVars = {
      ...process.env,
      FAST_SHUTDOWN: "true",
      PORT: String(controlPlanePort),
      DATABASE_URL: `postgresql://threa:threa@localhost:5454/${TEST_CP_DB_NAME}`,
      USE_STUB_AUTH: "true",
      INTERNAL_API_KEY: backendEnv.INTERNAL_API_KEY ?? "dev-internal-key",
      REGIONS: JSON.stringify({ local: { internalUrl: `http://localhost:${backendPort}` } }),
      CORS_ALLOWED_ORIGINS: corsOrigins,
      WORKSPACE_CREATION_SKIP_INVITE: "true",
      PLATFORM_ADMIN_WORKOS_USER_IDS: devPlatformAdminId,
      // Send the frontend-bound redirect back to the backoffice app after login
      // when the request came in via X-Forwarded-Host from the backoffice-router.
      FRONTEND_URL: `http://localhost:${frontendPort}`,
    }

    // Set environment variables for frontend (proxies API calls through the router)
    const frontendEnvVars = {
      ...process.env,
      VITE_PORT: String(frontendPort),
      VITE_BACKEND_PORT: String(routerPort),
    }

    // Backoffice proxies /api through the backoffice-router (same topology as
    // prod: browser → backoffice-router → control-plane).
    const backofficeEnvVars = {
      ...process.env,
      VITE_PORT: String(backofficePort),
      VITE_API_PROXY_PORT: String(backofficeRouterPort),
    }

    // Build the REGIONS config pointing to the dynamic backend port
    const regionsJson = JSON.stringify({
      local: {
        apiUrl: `http://localhost:${backendPort}`,
        wsUrl: `ws://localhost:${backendPort}`,
      },
    })

    console.log("\nStarting dev server in test mode:")
    console.log(`  - Database: ${TEST_DB_NAME}`)
    console.log(`  - Control Plane DB: ${TEST_CP_DB_NAME}`)
    console.log(`  - Stub Auth: enabled`)
    console.log(`  - Workspace Invite Check: skipped`)
    console.log(`  - Platform admin seed: ${devPlatformAdminEmail}`)
    console.log(`  - Frontend: http://localhost:${frontendPort}`)
    console.log(`  - Router: http://localhost:${routerPort}`)
    console.log(`  - Backoffice: http://localhost:${backofficePort}`)
    console.log(`  - Backoffice router: http://localhost:${backofficeRouterPort}`)
    console.log(`  - Control Plane: http://localhost:${controlPlanePort}`)
    console.log(`  - Backend: http://localhost:${backendPort}\n`)

    // Run control-plane without --hot (more stable for testing)
    const controlPlane = Bun.spawn(["bun", "apps/control-plane/src/index.ts"], {
      stdout: "inherit",
      stderr: "inherit",
      env: controlPlaneEnvVars,
    })

    // Run backend without --hot (more stable for testing)
    const backend = Bun.spawn(["bun", "apps/backend/src/index.ts"], {
      stdout: "inherit",
      stderr: "inherit",
      env: backendEnvVars,
    })

    const routerDir = path.join(process.cwd(), "apps/workspace-router")
    // Wrangler's devtools inspector defaults to 9229/9230. Running two
    // wrangler processes on the same box (workspace-router + backoffice-
    // router) means the second one would fail with "Address already in
    // use" — so each dev-test router gets its own inspector port derived
    // from its dev port.
    const router = Bun.spawn(
      [
        "bunx",
        "wrangler",
        "dev",
        "--port",
        String(routerPort),
        "--inspector-port",
        String(routerPort + 1000),
        "--var",
        "DEFAULT_REGION:local",
        "--var",
        `CONTROL_PLANE_URL:http://localhost:${controlPlanePort}`,
        "--var",
        `REGIONS:${regionsJson}`,
        // Without this the router's `resolveRegion` control-plane lookup is
        // skipped entirely and EVERY uncached workspace 404s ("Workspace not
        // found") — the same shared secret the backend + control-plane get.
        "--var",
        `INTERNAL_API_KEY:${backendEnv.INTERNAL_API_KEY ?? "dev-internal-key"}`,
      ],
      {
        cwd: routerDir,
        stdout: "inherit",
        stderr: "inherit",
      }
    )

    const frontend = Bun.spawn(["bun", "run", "--cwd", "apps/frontend", "dev"], {
      stdout: "inherit",
      stderr: "inherit",
      env: frontendEnvVars,
    })

    const backofficeRouterDir = path.join(process.cwd(), "apps/backoffice-router")
    const backofficeRouter = Bun.spawn(
      [
        "bunx",
        "wrangler",
        "dev",
        "--port",
        String(backofficeRouterPort),
        "--inspector-port",
        String(backofficeRouterPort + 1000),
        "--var",
        `CONTROL_PLANE_URL:http://localhost:${controlPlanePort}`,
      ],
      {
        cwd: backofficeRouterDir,
        stdout: "inherit",
        stderr: "inherit",
      }
    )

    const backoffice = Bun.spawn(["bun", "run", "--cwd", "apps/backoffice", "dev"], {
      stdout: "inherit",
      stderr: "inherit",
      env: backofficeEnvVars,
    })

    // Handle shutdown
    let isShuttingDown = false
    const shutdown = async () => {
      if (isShuttingDown) return
      isShuttingDown = true
      console.log("\nShutting down test server...")
      controlPlane.kill("SIGKILL")
      backend.kill("SIGKILL")
      router.kill("SIGKILL")
      backofficeRouter.kill("SIGKILL")
      frontend.kill("SIGKILL")
      backoffice.kill("SIGKILL")
      await Promise.all([
        controlPlane.exited,
        backend.exited,
        router.exited,
        backofficeRouter.exited,
        frontend.exited,
        backoffice.exited,
      ])
      process.exit(0)
    }

    process.on("SIGINT", shutdown)
    process.on("SIGTERM", shutdown)

    await Promise.all([
      controlPlane.exited,
      backend.exited,
      router.exited,
      backofficeRouter.exited,
      frontend.exited,
      backoffice.exited,
    ])
  } catch (err) {
    console.error("Failed to start test server:", err)
    process.exit(1)
  }
}

main()
