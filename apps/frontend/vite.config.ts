/// <reference types="vitest" />
import { defineConfig, type Plugin } from "vite"
import react from "@vitejs/plugin-react"
import { VitePWA } from "vite-plugin-pwa"
import { execSync } from "child_process"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "path"
import { postHogSourceMapPlugins } from "./scripts/posthog-source-maps"

// Ports can be configured via env vars for browser E2E tests
const backendPort = process.env.VITE_BACKEND_PORT || "3001"
const socketPort = process.env.VITE_SOCKET_PORT || "3002"
const frontendPort = parseInt(process.env.VITE_PORT?.trim() || "3000", 10)
const backendTarget = `http://localhost:${backendPort}`
const socketTarget = `http://localhost:${socketPort}`
const allowedHosts = (process.env.VITE_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean)

// Disable HMR during E2E tests to avoid noisy WebSocket errors when Playwright closes tabs
const isE2ETest = !!process.env.VITE_BACKEND_PORT

// Build version from git short hash — used for auto-update detection.
// Falls back to a build timestamp so auto-update still works in gitless CI environments.
const buildTimestamp = new Date().toISOString()
let buildVersion: string
try {
  buildVersion = execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim()
} catch {
  buildVersion = `build-${Date.parse(buildTimestamp)}`
}

// Unique artifact identity: same commit rebuilt produces a different id.
const buildId = `${buildVersion}@${buildTimestamp}`

let buildOutputDir: string

function versionJsonPlugin(): Plugin {
  return {
    name: "version-json",
    apply: "build",
    configResolved(config) {
      buildOutputDir = path.resolve(config.root, config.build.outDir)
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "version.json",
        source: JSON.stringify({ version: buildVersion, builtAt: buildTimestamp }),
      })
    },
  }
}

function withForwardedHostHeaders() {
  return {
    configure(proxy: {
      on(
        event: "proxyReq",
        listener: (
          proxyReq: { setHeader(name: string, value: string): void },
          req: {
            headers: Record<string, string | string[] | undefined>
          }
        ) => void
      ): void
    }) {
      proxy.on("proxyReq", (proxyReq, req) => {
        const rawHost = req.headers.host
        const host = Array.isArray(rawHost) ? rawHost[0] : rawHost
        if (!host) return

        const forwardedProtoHeader = req.headers["x-forwarded-proto"]
        const forwardedProto = Array.isArray(forwardedProtoHeader) ? forwardedProtoHeader[0] : forwardedProtoHeader
        const port = host.includes(":") ? (host.split(":").at(-1) ?? "") : ""

        proxyReq.setHeader("x-forwarded-host", host)
        proxyReq.setHeader("x-forwarded-proto", forwardedProto ?? "http")
        if (port) {
          proxyReq.setHeader("x-forwarded-port", port)
        }
      })
    },
  }
}

function buildProxyConfig() {
  // /api and /test-auth-login go through the workspace router. Socket.IO
  // normally connects directly to the region URL, but Tailscale remote mode
  // deliberately uses the frontend origin so one HTTPS Serve listener can
  // carry the app, API, and WebSocket without exposing extra ports.
  return {
    "/api": {
      target: backendTarget,
      changeOrigin: true,
      xfwd: true,
      ...withForwardedHostHeaders(),
    },
    "/test-auth-login": {
      target: backendTarget,
      changeOrigin: true,
      xfwd: true,
      ...withForwardedHostHeaders(),
    },
    "/socket.io": {
      target: socketTarget,
      changeOrigin: true,
      xfwd: true,
      ws: true,
      ...withForwardedHostHeaders(),
    },
  }
}

export default defineConfig({
  plugins: [
    react(),
    versionJsonPlugin(),
    ...postHogSourceMapPlugins(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      injectRegister: false, // we register manually in main.tsx with updateViaCache: 'none'
      manifest: false, // use existing public/manifest.json
      injectManifest: {
        // E2E serves a fresh build behind `vite preview`, so precaching ~14 MiB
        // of assets into CacheStorage on every test's first load just adds
        // hundreds of background requests per test and competes with the run.
        // The SW still registers (push tests need it) and its navigation handler
        // falls through to the network when nothing is precached.
        globPatterns: isE2ETest ? [] : ["**/*.{js,mjs,css,html,ico,png,svg,woff,woff2}"],
        // recover.html is the nuclear-option SW-unregister page (public/recover.html).
        // It must stay network-served even when the app shell is broken; precaching
        // it would route recovery through the SW it is trying to unregister.
        globIgnores: ["**/recover.html"],
        // Add Subresource Integrity to each precache entry. A failed integrity
        // match aborts the install, so a stale HTTP response or mis-served HTML
        // can never silently become the precached shell for the next build.
        manifestTransforms: [
          async (entries) => ({
            manifest: await Promise.all(
              entries.map(async (entry) => {
                const bytes = await readFile(path.join(buildOutputDir, entry.url))
                const integrity = `sha384-${createHash("sha384").update(bytes).digest("base64")}`
                return { ...entry, integrity }
              })
            ),
            warnings: [],
          }),
        ],
      },
      devOptions: {
        enabled: true,
        type: "module",
      },
    }),
  ],
  // Bake the build version into the bundle so the running app can tell whether a
  // reload actually swapped in new code. Same value as the emitted version.json.
  // __APP_BUILD_ID__ is the unique artifact identity used for precache buckets
  // and update notification deduplication.
  define: {
    __APP_VERSION__: JSON.stringify(buildVersion),
    __APP_BUILT_AT__: JSON.stringify(buildTimestamp),
    __APP_BUILD_ID__: JSON.stringify(buildId),
    // True only in the Playwright E2E build (VITE_BACKEND_PORT is set). Lets the
    // app suppress the persistent "new version available" update toast, which
    // otherwise parks over the composer in the aria-live region and intercepts
    // pointer events for the rest of a test. The SW itself still registers.
    __E2E_BUILD__: JSON.stringify(isE2ETest),
  },
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    // Maps are uploaded to PostHog and deleted before deploy (deploy-cloudflare.yml).
    sourcemap: "hidden",
  },
  test: {
    // Two projects so the Node build-script tests under scripts/ don't drag in
    // the jsdom UI bootstrap (./src/test/setup.ts → @/db, localStorage, DOM
    // polyfills) that has nothing to do with a filesystem script.
    projects: [
      {
        extends: true,
        test: {
          name: "frontend",
          globals: true,
          environment: "jsdom",
          setupFiles: ["./src/test/setup.ts"],
          include: ["src/**/*.test.{ts,tsx}"],
        },
      },
      {
        extends: true,
        test: {
          name: "scripts",
          globals: true,
          environment: "node",
          include: ["scripts/**/*.test.ts"],
        },
      },
    ],
  },
  server: {
    host: "0.0.0.0",
    port: frontendPort,
    // Bind the port asked for or fail. Vite's default is to slide to the next
    // free one, which leaves the dev stack's readiness probe, its CORS origins
    // and its Tailscale proxy all addressing a server that is not this one.
    strictPort: true,
    allowedHosts,
    hmr: isE2ETest ? false : undefined,
    proxy: buildProxyConfig(),
    watch: {
      usePolling: true,
      interval: 100,
    },
  },
  // E2E runs against a production build served by `vite preview` (see
  // playwright.config.ts). The preview server needs the same proxy as the dev
  // server, since proxy config does not carry over from `server`.
  preview: {
    host: "0.0.0.0",
    port: frontendPort,
    strictPort: true,
    proxy: buildProxyConfig(),
  },
})
