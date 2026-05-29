import { describe, it, expect } from "bun:test"
import type { Pool } from "pg"
import { GitHubClient, WorkspaceIntegrationService } from "./service"
import type { GitHubAppConfig, LinearOAuthConfig } from "../../lib/env"

const githubDisabled: GitHubAppConfig = {
  enabled: false,
  appId: "",
  appSlug: "",
  privateKey: "",
  integrationSecret: "secret",
}

const linearDisabled: LinearOAuthConfig = {
  enabled: false,
  clientId: "",
  clientSecret: "",
  redirectUri: "",
  integrationSecret: "secret",
}

const githubEnabled: GitHubAppConfig = {
  enabled: true,
  appId: "123456",
  appSlug: "threa-test",
  privateKey: "-----BEGIN RSA PRIVATE KEY-----\nMIItest\n-----END RSA PRIVATE KEY-----",
  integrationSecret: "secret",
}

// A pool that throws if touched — the no-app paths must resolve before any query.
const explodingPool = {
  query: () => {
    throw new Error("pool should not be queried when no GitHub app is configured")
  },
} as unknown as Pool

function makeService(): WorkspaceIntegrationService {
  return new WorkspaceIntegrationService({ pool: explodingPool, github: githubDisabled, linear: linearDisabled })
}

// Build a service whose app is configured and whose integration lookup returns a
// single canned row, so the rate-limit branch is reachable without a real DB.
function makeServiceWithRow(row: Record<string, unknown>): WorkspaceIntegrationService {
  const pool = { query: async () => ({ rows: [row] }) } as unknown as Pool
  return new WorkspaceIntegrationService({ pool, github: githubEnabled, linear: linearDisabled })
}

describe("getGithubClient unauthenticated fallback", () => {
  it("returns null when no app is configured and no fallback is requested", async () => {
    const service = makeService()
    expect(await service.getGithubClient("ws_1")).toBeNull()
  })

  it("returns an anonymous GitHub client when the fallback is requested, so public repos still work", async () => {
    const service = makeService()
    const client = await service.getGithubClient("ws_1", { allowUnauthenticatedFallback: true })
    expect(client).toBeInstanceOf(GitHubClient)
  })

  it("builds an anonymous client without installation state", () => {
    const service = makeService()
    const client = GitHubClient.anonymous(service, "ws_1")
    expect(client).toBeInstanceOf(GitHubClient)
  })

  it("does NOT fall back to anonymous when an active integration is near its rate limit", async () => {
    // A throttled installation is a back-off circuit-breaker, not a missing
    // integration: it must keep returning null (surfaced as GITHUB_NOT_CONNECTED)
    // rather than silently downgrade a heavy user onto the per-IP anonymous quota.
    const resetInFuture = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    const service = makeServiceWithRow({
      id: "wsi_1",
      workspace_id: "ws_1",
      provider: "github",
      status: "active",
      credentials: {},
      metadata: { rateLimitRemaining: 5, rateLimitResetAt: resetInFuture },
      installed_by: "user_1",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    const client = await service.getGithubClient("ws_1", { allowUnauthenticatedFallback: true })
    expect(client).toBeNull()
  })
})
