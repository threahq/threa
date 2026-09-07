import { defineConfig, devices } from "@playwright/test"
import { fileURLToPath } from "node:url"
import { reserveServerPortSync } from "./support/port"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
const port = reserveServerPortSync()

export default defineConfig({
  testDir: "./specs",
  globalTeardown: "./cleanup.ts",
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["line"], ["html", { open: "never" }]] : "list",
  timeout: 60000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `bun "${__dirname}/build.ts" && exec bun "${__dirname}/server.ts"`,
    url: `http://127.0.0.1:${port}/__ready`,
    reuseExistingServer: false,
    timeout: 180000,
    env: { APP_UPDATE_SERVER_PORT: String(port) },
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
  ],
})
