import { $ } from "bun"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

const POSTGRES_HOST = "localhost"
const POSTGRES_PORT = 5454
const MINIO_HOST = "localhost"
const MINIO_PORT = 9000
const MINIO_BUCKET = "threa-uploads"

function loadEnvFile(filePath: string): Record<string, string> {
  const env: Record<string, string> = {}
  if (!fs.existsSync(filePath)) return env

  const content = fs.readFileSync(filePath, "utf-8")
  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eqIndex = trimmed.indexOf("=")
    if (eqIndex === -1) continue
    const key = trimmed.slice(0, eqIndex)
    let value = trimmed.slice(eqIndex + 1)
    // Remove surrounding quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    env[key] = value
  }
  return env
}

interface WorktreeInfo {
  path: string
  branch: string
  isMain: boolean
}

async function getWorktrees(): Promise<WorktreeInfo[]> {
  const result = await $`git worktree list --porcelain`.text()
  const worktrees: WorktreeInfo[] = []
  let current: Partial<WorktreeInfo> = {}

  for (const line of result.split("\n")) {
    if (line.startsWith("worktree ")) {
      current.path = line.slice(9)
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice(7)
    } else if (line === "bare") {
      current.isMain = true
    } else if (line === "") {
      if (current.path) {
        worktrees.push({
          path: current.path,
          branch: current.branch || "unknown",
          isMain: current.isMain || false,
        })
      }
      current = {}
    }
  }

  return worktrees
}

function getMainWorktree(worktrees: WorktreeInfo[]): WorktreeInfo | undefined {
  // First try to find the bare repo
  const bare = worktrees.find((w) => w.isMain)
  if (bare) return bare
  // Try the one on main/master branch
  const mainBranch = worktrees.find((w) => w.branch.endsWith("/main") || w.branch.endsWith("/master"))
  if (mainBranch) return mainBranch
  // Otherwise, the main worktree is the one without a dot suffix (e.g., "threa" vs "threa.feature")
  // This is a common convention for git worktrees
  const primary = worktrees.find((w) => !path.basename(w.path).includes("."))
  if (primary) return primary
  // Last resort: first worktree (usually the original)
  return worktrees[0]
}

function deriveDatabaseName(dirPath: string): string {
  const dirName = path.basename(dirPath)
  // Convert to valid postgres identifier
  const sanitized = dirName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
  return sanitized || "threa"
}

function getExplicitLanHost(): string | undefined {
  const raw = process.env.LAN_HOST ?? process.env.LAN_IP
  if (!raw) return undefined

  try {
    const url = new URL(raw.includes("://") ? raw : `http://${raw}`)
    return url.hostname
  } catch {
    console.error(`Invalid LAN_HOST/LAN_IP value: ${raw}`)
    process.exit(1)
  }
}

function getDefaultLanHost(): string | undefined {
  return Object.values(os.networkInterfaces())
    .flat()
    .find((i) => i && i.family === "IPv4" && !i.internal)?.address
}

/**
 * Best-effort Tailscale MagicDNS hostname so LAN mode also serves devices on
 * the tailnet (e.g. a phone off the home WiFi). Tries the CLI on PATH first,
 * then the macOS app-bundle binary. Returns undefined when Tailscale is
 * absent or not running — LAN mode then behaves exactly as before.
 */
async function getTailscaleHost(): Promise<string | undefined> {
  const candidates = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]
  for (const bin of candidates) {
    const result = await $`${bin} status --json`.quiet().nothrow()
    if (result.exitCode !== 0) continue
    try {
      const status = JSON.parse(result.stdout.toString())
      const dnsName: unknown = status?.Self?.DNSName
      if (status?.BackendState === "Running" && typeof dnsName === "string" && dnsName.length > 0) {
        // MagicDNS names come back fully qualified with a trailing dot.
        return dnsName.replace(/\.$/, "")
      }
    } catch {
      // Unparseable output — try the next candidate.
    }
  }
  return undefined
}

async function ensureWorktreeEnv(): Promise<void> {
  const cwd = process.cwd()
  const backendEnvPath = path.join(cwd, "apps/backend/.env")

  // If .env exists, nothing to do
  if (fs.existsSync(backendEnvPath)) return

  const worktrees = await getWorktrees()
  const mainWorktree = getMainWorktree(worktrees)

  if (!mainWorktree) {
    console.warn("Could not find main worktree - .env setup skipped")
    return
  }

  // Check if we're in the main worktree
  if (mainWorktree.path === cwd) return

  const sourceEnvPath = path.join(mainWorktree.path, "apps/backend/.env")
  if (!fs.existsSync(sourceEnvPath)) {
    console.warn(`No .env in main worktree (${sourceEnvPath}) - cannot auto-setup`)
    return
  }

  // Copy and modify .env
  const dbName = deriveDatabaseName(cwd)
  console.log(`Setting up worktree .env with database: ${dbName}`)

  let content = fs.readFileSync(sourceEnvPath, "utf-8")
  content = content.replace(/(DATABASE_URL=postgresql:\/\/[^/]+\/)([^?\n]+)/, `$1${dbName}`)
  fs.writeFileSync(backendEnvPath, content)

  // Create database and copy data if postgres is reachable
  if (await isPostgresReachable()) {
    const checkResult =
      await $`docker exec threa-postgres-1 psql -U threa -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${dbName}'"`
        .quiet()
        .nothrow()
    if (checkResult.stdout.toString().trim() !== "1") {
      console.log(`Creating database '${dbName}'...`)
      await $`docker exec threa-postgres-1 psql -U threa -d postgres -c "CREATE DATABASE ${dbName}"`.quiet()

      // Copy schema + data from main database (threa) to worktree database
      // Duplicate schema errors are expected and harmless (migrations will reconcile)
      console.log(`Copying data from main database...`)
      const lockWaitTimeout = "10s"
      const copyResult =
        await $`docker exec threa-postgres-1 bash -o pipefail -c "pg_dump -U threa -d threa --no-owner --no-acl --lock-wait-timeout=${lockWaitTimeout} | PGOPTIONS='-c lock_timeout=${lockWaitTimeout}' psql -U threa -d ${dbName}"`
          .quiet()
          .nothrow()

      if (copyResult.exitCode !== 0) {
        const stderr = copyResult.stderr.toString()
        if (
          stderr.includes("canceling statement due to lock timeout") ||
          stderr.includes("canceling statement due to statement timeout")
        ) {
          console.warn(
            `Data copy skipped due to DB lock timeout. Close other processes using 'threa' and rerun setup if you need a cloned dataset.`
          )
        } else {
          console.warn(`Data copy had errors: ${stderr || `exit code ${copyResult.exitCode}`}`)
        }
      } else {
        console.log(`Data copied successfully`)
      }
    }
  }
}

async function isPostgresReachable(): Promise<boolean> {
  try {
    // Try TCP connection to postgres port
    const socket = await Bun.connect({
      hostname: POSTGRES_HOST,
      port: POSTGRES_PORT,
      socket: {
        data() {},
        open(socket) {
          socket.end()
        },
        error() {},
        close() {},
      },
    })
    socket.end()
    return true
  } catch {
    return false
  }
}

async function waitForPostgres(maxAttempts = 30): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    if (await isPostgresReachable()) {
      return true
    }
    await Bun.sleep(1000)
  }
  return false
}

async function isMinioReachable(): Promise<boolean> {
  try {
    const response = await fetch(`http://${MINIO_HOST}:${MINIO_PORT}/minio/health/live`)
    return response.ok
  } catch {
    return false
  }
}

async function waitForMinio(maxAttempts = 30): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    if (await isMinioReachable()) {
      return true
    }
    await Bun.sleep(1000)
  }
  return false
}

async function ensureMinioBucket(): Promise<void> {
  // Create bucket via mc CLI in container
  const aliasResult = await $`docker exec threa-minio-1 mc alias set local http://localhost:9000 minioadmin minioadmin`
    .quiet()
    .nothrow()

  if (aliasResult.exitCode !== 0) {
    console.warn("Could not set up MinIO alias - bucket creation may fail")
    return
  }

  // Check if bucket exists
  const lsResult = await $`docker exec threa-minio-1 mc ls local/${MINIO_BUCKET}`.quiet().nothrow()

  if (lsResult.exitCode !== 0) {
    // Bucket doesn't exist, create it
    const mbResult = await $`docker exec threa-minio-1 mc mb local/${MINIO_BUCKET}`.quiet().nothrow()
    if (mbResult.exitCode === 0) {
      console.log(`Created MinIO bucket: ${MINIO_BUCKET}`)
    } else {
      console.warn(`Could not create MinIO bucket: ${MINIO_BUCKET}`)
    }
  }
}

async function main() {
  // Check if postgres is already running (e.g., started from main worktree)
  const postgresRunning = await isPostgresReachable()
  const minioRunning = await isMinioReachable()

  if (postgresRunning && minioRunning) {
    console.log("PostgreSQL and MinIO are already running")
    await ensureWorktreeEnv()
    await ensureMinioBucket()
  } else {
    if (!postgresRunning) {
      console.log("Starting PostgreSQL...")
    }
    if (!minioRunning) {
      console.log("Starting MinIO...")
    }

    const result = await $`docker compose up -d postgres minio`.nothrow()

    if (result.exitCode !== 0) {
      console.error("Failed to start services via docker compose.")
      console.error("If you're in a git worktree, start services from the main threa folder:")
      console.error("  cd /path/to/threa && bun run db:start")
      process.exit(1)
    }

    if (!postgresRunning) {
      console.log("Waiting for PostgreSQL to be ready...")
      const ready = await waitForPostgres()
      if (!ready) {
        console.error("PostgreSQL failed to become ready")
        process.exit(1)
      }
      console.log("PostgreSQL is ready")
    }

    if (!minioRunning) {
      console.log("Waiting for MinIO to be ready...")
      const ready = await waitForMinio()
      if (!ready) {
        console.error("MinIO failed to become ready")
        process.exit(1)
      }
      console.log("MinIO is ready")
    }

    await ensureWorktreeEnv()
    await ensureMinioBucket()
  }

  console.log("Starting control-plane, workspace-router, backend, enclave and frontend...")

  // Load .env files (worktree-specific DATABASE_URL, etc.)
  const backendEnvPath = path.join(process.cwd(), "apps/backend/.env")
  const backendEnv = loadEnvFile(backendEnvPath)
  const cpEnvPath = path.join(process.cwd(), "apps/control-plane/.env")
  const cpEnv = loadEnvFile(cpEnvPath)

  const dbBase = backendEnv.DATABASE_URL ?? process.env.DATABASE_URL ?? "postgresql://threa:threa@localhost:5454/threa"
  const useStubAuth = backendEnv.USE_STUB_AUTH ?? process.env.USE_STUB_AUTH ?? "false"

  // Shared internal secret. The backend mounts /internal/enclave-runtimes/* only
  // when this is set, and the enclave must present the same value — so they
  // resolve from one source to avoid drift.
  const internalApiKey = backendEnv.INTERNAL_API_KEY ?? "dev-internal-key"

  // Derive control-plane DB URL from the backend's DATABASE_URL by appending _cp
  const cpDbUrl = dbBase.replace(/\/([^/?]+)(\?.*)?$/, "/$1_cp$2")

  // Ensure control-plane database exists
  if (await isPostgresReachable()) {
    const cpDbName = cpDbUrl.match(/\/([^/?]+?)(?:\?.*)?$/)?.[1] ?? "threa_cp"
    const checkResult =
      await $`docker exec threa-postgres-1 psql -U threa -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${cpDbName}'"`
        .quiet()
        .nothrow()
    if (checkResult.stdout.toString().trim() !== "1") {
      console.log(`Creating control-plane database '${cpDbName}'...`)
      await $`docker exec threa-postgres-1 psql -U threa -d postgres -c "CREATE DATABASE ${cpDbName}"`.quiet()
    }
  }

  // LAN mode: make the app reachable from phones. Every detected host gets
  // CORS + Vite allowedHosts coverage; auth callbacks can only bind to ONE
  // host (WORKOS_REDIRECT_URI is a single value), so an explicit LAN_HOST
  // wins, then the Tailscale MagicDNS name (works away from the home
  // network), then the WiFi IP.
  const explicitLanHost = getExplicitLanHost()
  const lanMode = process.env.LAN_MODE === "true" || process.argv.includes("--lan") || !!explicitLanHost
  let lanHosts: string[] = []
  let primaryLanHost: string | undefined

  if (lanMode) {
    const tailscaleHost = await getTailscaleHost()
    const defaultLanIp = getDefaultLanHost()
    lanHosts = [...new Set([explicitLanHost, tailscaleHost, defaultLanIp].filter((h): h is string => !!h))]

    if (lanHosts.length === 0) {
      console.error("LAN_MODE enabled but no LAN IP or Tailscale host found — are you connected to WiFi?")
      process.exit(1)
    }

    primaryLanHost = explicitLanHost ?? tailscaleHost ?? defaultLanIp
    for (const host of lanHosts) {
      console.log(`LAN mode: http://${host}:3000${host === primaryLanHost ? "  (auth callbacks)" : ""}`)
    }
  }

  const corsOrigins = [
    "http://localhost:3000",
    "http://localhost:3004",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
  ]
  for (const host of lanHosts) corsOrigins.push(`http://${host}:3000`)

  const cpEnvOverrides: Record<string, string> = {}
  if (primaryLanHost && cpEnv.WORKOS_REDIRECT_URI) {
    cpEnvOverrides.WORKOS_REDIRECT_URI = cpEnv.WORKOS_REDIRECT_URI.replace("localhost", primaryLanHost)
  }

  // Dev convenience: auto-seed a platform admin for the default stub email so
  // the backoffice works out of the box after logging in as "admin@threa.io".
  // Stub user IDs are deterministic: `workos_test_${base64url(email)}`.
  const DEV_PLATFORM_ADMIN_EMAIL = "admin@threa.io"
  const devPlatformAdminId = `workos_test_${Buffer.from(DEV_PLATFORM_ADMIN_EMAIL).toString("base64url")}`
  const platformAdminIds =
    cpEnv.PLATFORM_ADMIN_WORKOS_USER_IDS ?? process.env.PLATFORM_ADMIN_WORKOS_USER_IDS ?? devPlatformAdminId

  const controlPlane = Bun.spawn(["bun", "--hot", "apps/control-plane/src/index.ts"], {
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      ...cpEnv,
      ...cpEnvOverrides,
      FAST_SHUTDOWN: "true",
      PORT: "3003",
      DATABASE_URL: cpDbUrl,
      USE_STUB_AUTH: useStubAuth,
      INTERNAL_API_KEY: cpEnv.INTERNAL_API_KEY ?? "dev-internal-key",
      REGIONS: JSON.stringify({ local: { internalUrl: "http://localhost:3002" } }),
      CORS_ALLOWED_ORIGINS: corsOrigins.join(","),
      WORKSPACE_CREATION_SKIP_INVITE: "true",
      PLATFORM_ADMIN_WORKOS_USER_IDS: platformAdminIds,
    },
  })

  const backend = Bun.spawn(["bun", "--hot", "apps/backend/src/index.ts"], {
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      ...backendEnv,
      FAST_SHUTDOWN: "true",
      PORT: "3002",
      DATABASE_URL: dbBase,
      USE_STUB_AUTH: useStubAuth,
      CONTROL_PLANE_URL: "http://localhost:3003",
      INTERNAL_API_KEY: internalApiKey,
      CORS_ALLOWED_ORIGINS: corsOrigins.join(","),
      REGION: "local",
    },
  })

  const routerDir = path.join(process.cwd(), "apps/workspace-router")
  const router = Bun.spawn(["bunx", "wrangler", "dev", "--port", "3001"], {
    cwd: routerDir,
    stdout: "inherit",
    stderr: "inherit",
  })

  const backofficeRouterDir = path.join(process.cwd(), "apps/backoffice-router")
  const backofficeRouter = Bun.spawn(["bunx", "wrangler", "dev", "--port", "3005", "--inspector-port", "9230"], {
    cwd: backofficeRouterDir,
    stdout: "inherit",
    stderr: "inherit",
  })

  const frontend = Bun.spawn(["bun", "run", "--cwd", "apps/frontend", "dev"], {
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      // Vite rejects unknown Host headers for non-IP hostnames, so every
      // LAN-mode host (Tailscale name included) must be allowlisted or the
      // phone's request bounces with "Blocked request".
      VITE_ALLOWED_HOSTS: [...new Set([...(process.env.VITE_ALLOWED_HOSTS?.split(",") ?? []), ...lanHosts])]
        .map((host) => host.trim())
        .filter(Boolean)
        .join(","),
    },
  })

  const backoffice = Bun.spawn(["bun", "run", "--cwd", "apps/backoffice", "dev"], {
    stdout: "inherit",
    stderr: "inherit",
  })

  // Enclave (Ariadne E2E). It runs on Node, not Bun — Bun 1.3.x's WebCrypto
  // lacks X25519 `deriveBits`, which the enclave needs to unwrap the per-stream
  // key. Bun only bundles it. Build once up front so `node --watch` has a file
  // to load, then run a rebuild-watcher beside the Node process. It registers
  // with the backend at :3002 (not the :3001 router) using the shared key.
  const enclaveDir = path.join(process.cwd(), "apps/enclave")
  console.log("Building enclave bundle...")
  await $`bun build src/index.ts --target=node --format=esm --outfile dist/index.mjs`.cwd(enclaveDir).quiet()

  const enclaveBuilder = Bun.spawn(
    ["bun", "build", "src/index.ts", "--target=node", "--format=esm", "--outfile", "dist/index.mjs", "--watch"],
    {
      cwd: enclaveDir,
      stdout: "inherit",
      stderr: "inherit",
    }
  )

  const enclave = Bun.spawn(["node", "--watch", "dist/index.mjs"], {
    cwd: enclaveDir,
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      PORT: "3011",
      ENCLAVE_SELF_URL: "http://localhost:3011",
      BACKEND_BASE_URL: "http://localhost:3002",
      INTERNAL_API_KEY: internalApiKey,
      // Dev only: persist the EIK across `node --watch` restarts so a code
      // change doesn't mint a fresh key and silently break every E2E stream's
      // wraps. Prod never sets this — the key stays ephemeral.
      ENCLAVE_KEY_PERSIST_PATH: path.join(enclaveDir, ".enclave-key.dev.json"),
    },
  })

  // Track if we're shutting down to avoid double-kill
  let isShuttingDown = false

  const shutdown = async () => {
    if (isShuttingDown) return
    isShuttingDown = true

    console.log("\nShutting down...")

    // Use SIGKILL for immediate termination in development
    controlPlane.kill("SIGKILL")
    backend.kill("SIGKILL")
    router.kill("SIGKILL")
    backofficeRouter.kill("SIGKILL")
    frontend.kill("SIGKILL")
    backoffice.kill("SIGKILL")
    enclaveBuilder.kill("SIGKILL")
    enclave.kill("SIGKILL")

    // Wait for processes to fully terminate
    await Promise.all([
      controlPlane.exited,
      backend.exited,
      router.exited,
      backofficeRouter.exited,
      frontend.exited,
      backoffice.exited,
      enclaveBuilder.exited,
      enclave.exited,
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
    enclaveBuilder.exited,
    enclave.exited,
  ])
}

main()
