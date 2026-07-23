/// <reference types="vitest" />
import { defineConfig, type Plugin } from "vite"
import react from "@vitejs/plugin-react"
import { VitePWA } from "vite-plugin-pwa"
import { execSync } from "child_process"
import path from "path"

// Ports can be configured via env vars for browser E2E tests
const backendPort = process.env.VITE_BACKEND_PORT || "3001"
const socketPort = process.env.VITE_SOCKET_PORT || "3002"
const frontendPort = parseInt(process.env.VITE_PORT || "3000", 10)
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

function versionJsonPlugin(): Plugin {
  return {
    name: "version-json",
    apply: "build",
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
        globPatterns: isE2ETest ? [] : ["**/*.{js,css,html,ico,png,svg}"],
        // recover.html is the nuclear-option SW-unregister page (public/recover.html).
        // It must stay network-served even when the app shell is broken; precaching
        // it would route recovery through the SW it is trying to unregister.
        globIgnores: ["**/recover.html"],
      },
      devOptions: {
        enabled: true,
        type: "module",
      },
    }),
  ],
  // Bake the build version into the bundle so the running app can tell whether a
  // reload actually swapped in new code (see use-app-update reconcilePostReload).
  // Same value as the emitted version.json, so a post-reload mismatch is decisive.
  define: {
    __APP_VERSION__: JSON.stringify(buildVersion),
    __APP_BUILT_AT__: JSON.stringify(buildTimestamp),
    // True only in the Playwright E2E build (VITE_BACKEND_PORT is set). Lets the
    // app suppress the persistent "new version available" update toast, which
    // otherwise parks over the composer in the aria-live region and intercepts
    // pointer events for the rest of a test (see use-app-update). The SW itself
    // still registers — only the click-blocking toast is gated.
    __E2E_BUILD__: JSON.stringify(isE2ETest),
  },
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
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
    proxy: buildProxyConfig(),
  },
})
