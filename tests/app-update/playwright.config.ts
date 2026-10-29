import { defineConfig, devices } from "@playwright/test"
import { fileURLToPath } from "node:url"
import { reserveServerPortSync } from "./support/port"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
const chromiumPort = reserveServerPortSync("APP_UPDATE_CHROMIUM_PORT")
const firefoxPort = reserveServerPortSync("APP_UPDATE_FIREFOX_PORT")
if (chromiumPort === firefoxPort) throw new Error("App-update browsers require distinct server ports")

export default defineConfig({
  testDir: "./specs",
  globalTeardown: "./cleanup.ts",
  workers: process.env.CI ? 2 : 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["line"], ["html", { open: "never" }]] : "list",
  timeout: 60000,
  use: {
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `bun "${__dirname}/build.ts" && exec bun "${__dirname}/server.ts"`,
    url: `http://127.0.0.1:${chromiumPort}/__ready`,
    reuseExistingServer: false,
    timeout: 180000,
    env: { APP_UPDATE_CHROMIUM_PORT: String(chromiumPort), APP_UPDATE_FIREFOX_PORT: String(firefoxPort) },
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${chromiumPort}` } },
    { name: "firefox", use: { ...devices["Desktop Firefox"], baseURL: `http://127.0.0.1:${firefoxPort}` } },
  ],
})
