import { defineConfig, devices } from "@playwright/test"
import * as path from "path"
import * as net from "net"

/**
 * Test infrastructure ports.
 * - CI: Uses ports 5454/9000 (configured in GitHub Actions workflow)
 * - Local: Uses docker-compose.test.yml with separate ports to avoid dev conflicts
 */
const isCI = !!process.env.CI
const DB_PORT = isCI ? 5454 : 5455
const MINIO_PORT = isCI ? 9000 : 9002

/**
 * Derive a unique database name from the current directory.
 * Same logic as setup-worktree.ts for consistency.
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
 * Find a free port synchronously using a temporary server.
 * This is a bit hacky but necessary since playwright config is synchronous.
 */
function findFreePortSync(): number {
  const server = net.createServer()
  server.listen(0)
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  server.close()
  return port
}

/**
 * Get or allocate a port, caching in environment variables.
 * Playwright re-evaluates config in worker processes - we need stable ports.
 */
function getOrAllocatePort(envVar: string): number {
  if (process.env[envVar]) {
    return parseInt(process.env[envVar]!, 10)
  }
  const port = findFreePortSync()
  process.env[envVar] = String(port)
  return port
}

// Find free ports for this test run (allows parallel execution across worktrees)
// Ports are cached in env vars so worker processes use the same ports
const backendPort = getOrAllocatePort("PLAYWRIGHT_BACKEND_PORT")
const controlPlanePort = getOrAllocatePort("PLAYWRIGHT_CONTROL_PLANE_PORT")
const routerPort = getOrAllocatePort("PLAYWRIGHT_ROUTER_PORT")
const frontendPort = getOrAllocatePort("PLAYWRIGHT_FRONTEND_PORT")
// The calls media plane in e2e: a local fake Cloudflare Realtime server (the spike
// harness's fake-cf-server in negotiationless mode) makes the backend's media plane
// "configured" without a real CF account. The calls suite asserts the control plane
// (roster/dock), never media bytes — see tests/browser/fake-cf-runner.ts.
const fakeCfPort = getOrAllocatePort("FAKE_CF_PORT")
const dbName = deriveTestDatabaseName()
const cpDbName = `${dbName}_cp`
const setupBrowserInfraCommand = "bun tests/browser/setup-infra.ts"
// In CI the backend, control-plane and router boot concurrently with the
// CPU-heavy frontend prod build (`vite build`) on a 4-vCPU runner, so their
// `/readyz` can lag well past a dev-machine cold start. A too-tight ceiling here
// fails the whole shard before a single test runs (no `.last-run.json` → the
// isolation-retry step bails → the shard is marked failed), which is a recurring
// source of red runs on otherwise-green commits. Give the boot real headroom in
// CI; locally these servers start fast (and are reused across runs).
const webServerTimeout = isCI ? 120000 : 60000

// In CI the frontend is served as a production build via `vite preview` rather
// than the Vite dev server: dev-mode on-demand transform competes for CPU with
// the parallel workers and the shared backend, which was the dominant source of
// contention timeouts. Locally we keep the dev server for fast iteration/HMR.
// The build is port-independent (VITE_BACKEND_PORT only configures the preview
// proxy at runtime), so the preview server still picks up the dynamic ports.
//
// Set PLAYWRIGHT_PROD_FRONTEND=1 to opt into the prod build locally without the
// rest of the CI environment (notably the 5454/9000 port remap). Prod-build-only
// failures — e.g. virtualized-list scroll position differing from the dev server
// — are otherwise impossible to reproduce on a dev machine.
const useProdFrontend = isCI || !!process.env.PLAYWRIGHT_PROD_FRONTEND
const usePrebuiltFrontend = !!process.env.PLAYWRIGHT_FRONTEND_PREBUILT
const frontendCommand = useProdFrontend
  ? `${usePrebuiltFrontend ? "" : "bun run --cwd apps/frontend build:e2e && "}bun run --cwd apps/frontend preview`
  : "bun run test:browser:frontend"
// The prod build needs more headroom than a dev-server boot.
const frontendServerTimeout = useProdFrontend ? 180000 : webServerTimeout

// Only log once (when ports are first allocated)
if (!process.env.PLAYWRIGHT_PORTS_LOGGED) {
  console.log(
    `Playwright config: backend=${backendPort}, control-plane=${controlPlanePort}, router=${routerPort}, frontend=${frontendPort}, db=${dbName}, cp_db=${cpDbName}, postgres=${DB_PORT}, minio=${MINIO_PORT}`
  )
  process.env.PLAYWRIGHT_PORTS_LOGGED = "true"
}

/**
 * Playwright configuration for browser E2E tests.
 *
 * These tests run against a real backend + frontend with a fresh test database.
 * The webServer config starts both servers before tests run.
 *
 * Ports are dynamically allocated to allow parallel test runs across worktrees.
 */
export default defineConfig({
  testDir: "./tests/browser",
  globalSetup: "./tests/browser/global-setup.ts",
  fullyParallel: true, // Each test creates unique user + workspace — safe to parallelize
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // CI: 2 workers. The 4-vCPU runner also hosts the backend, control-plane,
  // wrangler and the Vite preview server, so 3 workers (3 Chromiums + backend ≈
  // 4 saturated cores) left no headroom — a rotating ~1-test-per-shard tail kept
  // tripping on contention (slow assertions, clicks that never settle) and only
  // passing on the in-run retry. 2 workers leaves a spare core and the suite is
  // sharded ×4, so wall-clock stays well under the 25-min job budget.
  // Local: auto (half CPU cores).
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [["github"], ["line"], ["html", { open: "never" }]] : "list",
  // 30s locally for fast feedback. CI gets 60s: the shared 4-vCPU runner makes
  // setup + interaction-heavy flows (send-then-edit, hover-reveal menus) take
  // markedly longer under contention, and several tests were timing out mid-flow
  // only to pass on the isolated retry. A higher ceiling absorbs that without
  // masking a genuinely stuck test — the 25-min job timeout still bounds it.
  timeout: process.env.CI ? 60000 : 30000,

  use: {
    baseURL: `http://localhost:${frontendPort}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },

  projects: [
    {
      name: "chromium",
      // The calls suite needs fake-media launch flags + granted mic/camera, so it
      // runs as its own project below; keep it out of the default project.
      testIgnore: "**/calls.spec.ts",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "calls",
      testMatch: "**/calls.spec.ts",
      use: {
        ...devices["Desktop Chrome"],
        // getUserMedia resolves with a synthetic mic/camera and the permission
        // prompt auto-accepts, so a headless call reaches the connected phase
        // without a real device or a click-through. Grant the permissions too so
        // the context never blocks the capture.
        permissions: ["microphone", "camera"],
        launchOptions: {
          args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
        },
      },
    },
  ],

  // Start backend, workspace-router, and frontend before running tests
  // Ports are dynamically allocated to avoid conflicts with other worktrees
  webServer: [
    {
      // The calls media plane: a local fake Cloudflare Realtime server the backend
      // proxies to (negotiationless — forwards no media). Booting it here makes the
      // backend's CF app id/secret point at a live HTTP boundary so `cloudflareEnabled`
      // is true without a real CF account.
      command: "bun tests/browser/fake-cf-runner.ts",
      url: `http://localhost:${fakeCfPort}/healthz`,
      reuseExistingServer: !process.env.CI,
      timeout: webServerTimeout,
      env: { FAKE_CF_PORT: String(fakeCfPort) },
    },
    {
      command: `${setupBrowserInfraCommand} && bun run test:browser:backend`,
      url: `http://localhost:${backendPort}/readyz`,
      reuseExistingServer: !process.env.CI,
      timeout: webServerTimeout,
      env: {
        PORT: String(backendPort),
        DATABASE_URL: `postgresql://threa:threa@localhost:${DB_PORT}/${dbName}`,
        USE_STUB_AUTH: "true",
        SESSION_COOKIE_NAME: "wos_session_browser_test",
        USE_STUB_COMPANION: "true",
        USE_STUB_BOUNDARY_EXTRACTION: "true",
        USE_STUB_AI: "true",
        THREA_TEST_LOG_FILE: process.env.THREA_TEST_LOG_FILE,
        // Calls media plane → the fake CF server (negotiationless). App id/secret
        // present ⇒ `cloudflareRealtime.enabled`; the `calls` flag defaults on, so
        // the workspace has calls with no per-test enable step. Grace + sweep driven
        // low so an ended call's timeline card lands inside the test window.
        CLOUDFLARE_REALTIME_APP_ID: "e2e-calls-app",
        CLOUDFLARE_REALTIME_APP_SECRET: "e2e-calls-secret",
        CLOUDFLARE_REALTIME_API_BASE: `http://localhost:${fakeCfPort}/v1/apps`,
        CALL_EMPTY_GRACE_MS: "2000",
        CALL_SWEEP_INTERVAL_MS: "1000",
        // MinIO S3-compatible storage for file uploads
        S3_BUCKET: "threa-browser-test",
        S3_REGION: "us-east-1",
        S3_ACCESS_KEY_ID: "minioadmin",
        S3_SECRET_ACCESS_KEY: "minioadmin",
        S3_ENDPOINT: `http://localhost:${MINIO_PORT}`,
        // Security hardening: allow test origins through CORS, disable rate limits
        CORS_ALLOWED_ORIGINS: `http://localhost:${backendPort},http://localhost:${frontendPort}`,
        GLOBAL_RATE_LIMIT_MAX: "10000",
        AUTH_RATE_LIMIT_MAX: "10000",
        CONTROL_PLANE_URL: `http://localhost:${controlPlanePort}`,
        INTERNAL_API_KEY: "test-internal-key",
        ENCLAVE_INTERNAL_API_KEY: "test-enclave-key",
        REGION: "local",
        // VAPID keys for push notification E2E tests
        VAPID_PUBLIC_KEY: "BM1RQ2UEVpAlbEgYOQ3bDrGAOrJGBmmh4_4UkmtGRzhi-5WPFmPuJbA6zv4kCp0iycvTaH6eveCXedCE0xSnZbk",
        VAPID_PRIVATE_KEY: "eHUfakWGHrS4ft0HiSGyhTOBCQJ9VAKWl4XK53qsjMg",
        VAPID_SUBJECT: "mailto:test@threa.app",
      },
    },
    {
      command: `${setupBrowserInfraCommand} && bun run test:browser:control-plane`,
      url: `http://localhost:${controlPlanePort}/readyz`,
      reuseExistingServer: !process.env.CI,
      timeout: webServerTimeout,
      env: {
        PORT: String(controlPlanePort),
        DATABASE_URL: `postgresql://threa:threa@localhost:${DB_PORT}/${cpDbName}`,
        USE_STUB_AUTH: "true",
        SESSION_COOKIE_NAME: "wos_session_browser_test",
        INTERNAL_API_KEY: "test-internal-key",
        REGIONS: JSON.stringify({ local: { internalUrl: `http://localhost:${backendPort}` } }),
        CORS_ALLOWED_ORIGINS: `http://localhost:${controlPlanePort},http://localhost:${frontendPort}`,
        GLOBAL_RATE_LIMIT_MAX: "10000",
        WORKSPACE_CREATION_SKIP_INVITE: "true",
      },
    },
    {
      command: `bunx wrangler dev --port ${routerPort} --var CONTROL_PLANE_URL:http://localhost:${controlPlanePort} --var INTERNAL_API_KEY:test-internal-key --var 'REGIONS:${JSON.stringify({ local: { apiUrl: `http://localhost:${backendPort}`, wsUrl: `ws://localhost:${backendPort}` } })}'`,
      cwd: "./apps/workspace-router",
      url: `http://localhost:${routerPort}/readyz`,
      reuseExistingServer: !process.env.CI,
      timeout: webServerTimeout,
    },
    {
      command: frontendCommand,
      url: `http://localhost:${frontendPort}`,
      reuseExistingServer: !process.env.CI,
      timeout: frontendServerTimeout,
      env: {
        VITE_BACKEND_PORT: String(routerPort),
        VITE_PORT: String(frontendPort),
        VITE_DRAFT_DEBOUNCE_MS: "5",
      },
    },
  ],
})
