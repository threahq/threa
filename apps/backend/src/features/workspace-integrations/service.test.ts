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

// A pool that throws if touched — the no-app paths must resolve before any query.
const explodingPool = {
  query: () => {
    throw new Error("pool should not be queried when no GitHub app is configured")
  },
} as unknown as Pool

function makeService(): WorkspaceIntegrationService {
  return new WorkspaceIntegrationService({ pool: explodingPool, github: githubDisabled, linear: linearDisabled })
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
})
