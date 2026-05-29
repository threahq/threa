import { describe, it, expect } from "bun:test"
import { createMemoizedGithubClient, withGithubClient } from "./client-accessor"
import type { GitHubClient, WorkspaceIntegrationService } from "../../../workspace-integrations"

function makeService(fn: () => Promise<GitHubClient | null>): WorkspaceIntegrationService {
  return { getGithubClient: fn } as unknown as WorkspaceIntegrationService
}

describe("createMemoizedGithubClient options", () => {
  it("requests the unauthenticated fallback so agent tools can read public repos without an integration", async () => {
    let receivedOptions: unknown
    const service = {
      getGithubClient: async (_workspaceId: string, options?: unknown) => {
        receivedOptions = options
        return null
      },
    } as unknown as WorkspaceIntegrationService
    const getClient = createMemoizedGithubClient(service, "ws_1")
    await getClient()
    expect(receivedOptions).toEqual({ allowUnauthenticatedFallback: true })
  })
})

describe("createMemoizedGithubClient", () => {
  it("fetches once and reuses the resolved client across calls", async () => {
    let calls = 0
    const client = { request: async () => null } as unknown as GitHubClient
    const getClient = createMemoizedGithubClient(
      makeService(async () => {
        calls += 1
        return client
      }),
      "ws_1"
    )
    const [a, b, c] = await Promise.all([getClient(), getClient(), getClient()])
    expect(a).toBe(client)
    expect(b).toBe(client)
    expect(c).toBe(client)
    expect(calls).toBe(1)
  })

  it("caches a null (not-connected) result so chained tool calls don't re-query", async () => {
    let calls = 0
    const getClient = createMemoizedGithubClient(
      makeService(async () => {
        calls += 1
        return null
      }),
      "ws_1"
    )
    expect(await getClient()).toBe(null)
    expect(await getClient()).toBe(null)
    expect(calls).toBe(1)
  })

  it("clears the cache on rejection so a later call retries", async () => {
    const calls: unknown[] = []
    const client = { request: async () => null } as unknown as GitHubClient
    const getClient = createMemoizedGithubClient(
      makeService(async () => {
        calls.push(null)
        if (calls.length === 1) throw new Error("transient DB hiccup")
        return client
      }),
      "ws_1"
    )
    await expect(getClient()).rejects.toThrow("transient DB hiccup")
    const result = await getClient()
    expect(result).toBe(client)
    expect(calls.length).toBe(2)
  })
})

describe("withGithubClient", () => {
  it("maps an exception thrown by getClient to GITHUB_REQUEST_FAILED instead of letting it escape", async () => {
    const deps = {
      workspaceId: "ws_1",
      getClient: async () => {
        throw new Error("pool: no available connections")
      },
    }
    const result = await withGithubClient(deps, async () => "unreachable")
    expect(result).toEqual({
      error: "GitHub request failed: pool: no available connections",
      code: "GITHUB_REQUEST_FAILED",
    })
  })

  it("returns GITHUB_NOT_CONNECTED when getClient resolves to null", async () => {
    const deps = { workspaceId: "ws_1", getClient: async () => null }
    const result = await withGithubClient(deps, async () => "unreachable")
    expect(result).toMatchObject({ code: "GITHUB_NOT_CONNECTED" })
  })
})
