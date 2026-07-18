import { describe, it, expect, spyOn } from "bun:test"
import type { Pool } from "pg"
import { GitHubClient, WorkspaceIntegrationService } from "./service"
import { LinearApiError, LinearClient } from "./linear-client"
import type { LinearIntegrationCredentials, LinearIntegrationMetadata } from "./linear-client"
import type { WorkspaceIntegrationRecord } from "./repository"
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

const linearEnabled: LinearOAuthConfig = {
  enabled: true,
  clientId: "client",
  clientSecret: "secret",
  redirectUri: "https://example.test/callback",
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

describe("GitHubClient captureRateLimit is best-effort", () => {
  const credentials = {
    installationId: 42,
    accessToken: "at",
    tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  }
  const metadata = {
    organizationName: "acme",
    repositorySelection: "all" as const,
    permissions: {},
    repositories: [],
    rateLimitRemaining: null,
    rateLimitResetAt: null,
  }
  const record = {
    id: "wsi_1",
    workspaceId: "ws_1",
    provider: "github" as const,
    status: "active" as const,
    credentials: {},
    metadata: {},
    installedBy: "user_1",
    installationId: "42",
    createdAt: new Date(),
    updatedAt: new Date(),
  }

  it("a rate-limit DB failure during a 401 does not replace the GitHub error nor skip the refresh", async () => {
    const service = new WorkspaceIntegrationService({
      pool: explodingPool,
      github: githubEnabled,
      linear: linearDisabled,
    })

    // The rate-limit persist blows up (DB down). Without the best-effort wrapper
    // this would propagate from the catch path and pre-empt the 401 branch.
    const updateSpy = spyOn(service, "updateGithubRateLimitMetadata").mockRejectedValue(new Error("DB down"))
    // Refresh fails, so the flow rethrows the ORIGINAL GitHub 401 (proving the
    // 401 branch was reached — the retry path executed — and the DB error was
    // swallowed rather than surfaced).
    const refreshSpy = spyOn(service, "refreshGithubCredentialsForClient").mockResolvedValue(null)

    const client = new GitHubClient(service, "ws_1", record, credentials, metadata)
    const githubError = Object.assign(new Error("Unauthorized"), {
      status: 401,
      response: { headers: { "x-ratelimit-remaining": "50", "x-ratelimit-reset": "1234567890" } },
    })
    ;(client as unknown as { octokit: { request: () => Promise<unknown> } }).octokit = {
      request: async () => {
        throw githubError
      },
    }

    await expect(client.request("GET /x")).rejects.toBe(githubError)
    expect(updateSpy).toHaveBeenCalled()
    expect(refreshSpy).toHaveBeenCalled()
  })
})

describe("LinearClient captureRateLimit is best-effort", () => {
  const credentials: LinearIntegrationCredentials = {
    accessToken: "at",
    refreshToken: "rt",
    tokenType: "Bearer",
    tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    scope: "read",
    actor: "app",
  }
  const metadata: LinearIntegrationMetadata = {
    organizationId: "org_1",
    organizationName: "acme",
    organizationUrlKey: "acme",
    authorizedUser: null,
    rateLimit: {
      requestsRemaining: null,
      requestsResetAt: null,
      complexityRemaining: null,
      complexityResetAt: null,
    },
  }
  const record: WorkspaceIntegrationRecord = {
    id: "wsi_1",
    workspaceId: "ws_1",
    provider: "linear",
    status: "active",
    credentials: {},
    metadata: {},
    installedBy: "user_1",
    installationId: "org_1",
    createdAt: new Date(),
    updatedAt: new Date(),
  }

  it("a rate-limit DB failure during a 401 does not replace the Linear error nor skip the refresh", async () => {
    const service = new WorkspaceIntegrationService({
      pool: explodingPool,
      github: githubDisabled,
      linear: linearDisabled,
    })

    // The rate-limit persist blows up (DB down). Without the best-effort wrapper
    // this would propagate from captureRateLimit and pre-empt the 401 branch.
    const updateSpy = spyOn(service, "updateLinearRateLimitMetadata").mockRejectedValue(new Error("DB down"))
    // Refresh fails, so the flow throws the AUTHENTICATION_ERROR — proving the 401
    // branch was reached (the retry path executed) and the DB error was swallowed.
    const refreshSpy = spyOn(service, "refreshLinearCredentialsForPreview").mockResolvedValue(null)

    // 401 with rate-limit headers that differ from the all-null metadata, so the
    // persist branch fires before the 401 refresh branch runs.
    const fetchImpl = (async () =>
      new Response(null, {
        status: 401,
        headers: {
          "x-ratelimit-requests-remaining": "10",
          "x-ratelimit-requests-reset": "1234567890",
        },
      })) as unknown as typeof fetch

    const client = new LinearClient(service, "ws_1", record, credentials, metadata, fetchImpl)

    await expect(client.request("query { viewer { id } }")).rejects.toBeInstanceOf(LinearApiError)
    expect(updateSpy).toHaveBeenCalled()
    expect(refreshSpy).toHaveBeenCalled()
  })
})

describe("getAvailableToolCategories", () => {
  it("returns web + workspace only when no integrations are enabled, without touching the DB", async () => {
    const service = makeService()
    expect(await service.getAvailableToolCategories("ws_1")).toEqual(["web", "workspace"])
  })

  it("includes github when its integration is enabled and connected (active)", async () => {
    const service = makeServiceWithRow({
      id: "wsi_1",
      workspace_id: "ws_1",
      provider: "github",
      status: "active",
      credentials: {},
      metadata: {},
      installed_by: "user_1",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    expect(await service.getAvailableToolCategories("ws_1")).toEqual(["web", "workspace", "github"])
  })

  it("omits github when enabled for the deployment but not connected for the workspace", async () => {
    const pool = { query: async () => ({ rows: [] }) } as unknown as Pool
    const service = new WorkspaceIntegrationService({ pool, github: githubEnabled, linear: linearDisabled })
    expect(await service.getAvailableToolCategories("ws_1")).toEqual(["web", "workspace"])
  })

  it("includes linear when its integration is enabled and connected (active)", async () => {
    const service = new WorkspaceIntegrationService({
      pool: explodingPool,
      github: githubDisabled,
      linear: linearEnabled,
    })
    spyOn(service, "getLinearIntegration").mockResolvedValue({
      status: "active",
    } as Awaited<ReturnType<WorkspaceIntegrationService["getLinearIntegration"]>>)

    expect(await service.getAvailableToolCategories("ws_1")).toEqual(["web", "workspace", "linear"])
  })

  it("includes both github and linear when both are enabled and active", async () => {
    const service = new WorkspaceIntegrationService({
      pool: explodingPool,
      github: githubEnabled,
      linear: linearEnabled,
    })
    spyOn(service, "getGithubIntegration").mockResolvedValue({
      status: "active",
    } as Awaited<ReturnType<WorkspaceIntegrationService["getGithubIntegration"]>>)
    spyOn(service, "getLinearIntegration").mockResolvedValue({
      status: "active",
    } as Awaited<ReturnType<WorkspaceIntegrationService["getLinearIntegration"]>>)

    expect(await service.getAvailableToolCategories("ws_1")).toEqual(["web", "workspace", "github", "linear"])
  })

  it("omits linear when enabled for the deployment but not connected for the workspace", async () => {
    const service = new WorkspaceIntegrationService({
      pool: explodingPool,
      github: githubDisabled,
      linear: linearEnabled,
    })
    spyOn(service, "getLinearIntegration").mockResolvedValue(null)

    expect(await service.getAvailableToolCategories("ws_1")).toEqual(["web", "workspace"])
  })
})
