import { defineConfig, devices } from "@playwright/test"
import base from "./playwright.config"

const servers = Array.isArray(base.webServer) ? base.webServer : [base.webServer!]
const backend = servers.find((server) => server.command.includes("test:browser:backend"))!
export const spendingTestDatabaseUrl = backend.env!.DATABASE_URL

export default defineConfig({
  ...base,
  testMatch: "ai-spending.spec.ts",
  workers: 1,
  projects: [{ name: "spending", use: { ...devices["Desktop Chrome"] } }],
  webServer: servers.map((server) =>
    server === backend
      ? {
          ...server,
          command: server.command.replace(
            "bun run test:browser:backend",
            "bun tests/browser/spending-backend-runner.ts"
          ),
          reuseExistingServer: false,
          env: {
            ...server.env,
            USE_STUB_COMPANION: "false",
            OPENROUTER_API_KEY: "spending-test-only",
            TAVILY_API_KEY: "",
          POSTHOG_PROJECT_TOKEN: "",
          POSTHOG_HOST: "",
          },
        }
      : server
  ),
})
