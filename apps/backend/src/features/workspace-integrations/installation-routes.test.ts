import { describe, it, expect, afterEach, mock, spyOn } from "bun:test"
import type { Pool } from "pg"
import { GitHubClient, WorkspaceIntegrationService } from "./service"
import {
  WorkspaceIntegrationRepository,
  type UpsertWorkspaceIntegrationParams,
  type WorkspaceIntegrationRecord,
} from "./repository"
import { encryptJson } from "./crypto"
import { OutboxRepository } from "../../lib/outbox"
import type { GitHubAppConfig, LinearOAuthConfig } from "../../lib/env"

const SECRET = "secret"

const githubEnabled: GitHubAppConfig = {
  enabled: true,
  appId: "123456",
  appSlug: "threa-test",
  privateKey: "-----BEGIN RSA PRIVATE KEY-----\nMIItest\n-----END RSA PRIVATE KEY-----",
  integrationSecret: SECRET,
}

const linearDisabled: LinearOAuthConfig = {
  enabled: false,
  clientId: "",
  clientSecret: "",
  redirectUri: "",
  integrationSecret: SECRET,
}

interface QueryCall {
  text: string
  values: unknown[]
}

// A PoolClient-like double (it has `release`, so `withTransaction` treats it as
// an existing client and runs the callback against it via a savepoint — no
// `connect()`). It records every query and returns a scripted row set. Route
// (un)registration is now a `github_route:*` outbox event committed in the same
// transaction; `OutboxRepository.insert` is spied, so those writes never reach
// this double.
function recordingPool(rows: Array<Record<string, unknown>>): { pool: Pool; calls: QueryCall[] } {
  const calls: QueryCall[] = []
  const pool = {
    query: async (query: unknown, values: unknown[] = []) => {
      const text = typeof query === "string" ? query : ((query as { text?: string })?.text ?? "")
      calls.push({ text, values })
      return { rows, rowCount: rows.length }
    },
    release: () => {},
  } as unknown as Pool
  return { pool, calls }
}

/** A pool whose UPDATE matches 0 rows (a newer write / disconnect won the CAS). */
function guardMissPoolShared(selectRows: Array<Record<string, unknown>>): { pool: Pool; calls: QueryCall[] } {
  const calls: QueryCall[] = []
  const pool = {
    query: async (query: unknown, values: unknown[] = []) => {
      const text = typeof query === "string" ? query : ((query as { text?: string })?.text ?? "")
      calls.push({ text, values })
      if (text.includes("UPDATE workspace_integrations")) return { rows: [], rowCount: 0 }
      return { rows: selectRows, rowCount: selectRows.length }
    },
    release: () => {},
  } as unknown as Pool
  return { pool, calls }
}

function githubRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "wsi_1",
    workspace_id: "ws_1",
    provider: "github",
    status: "active",
    credentials: {},
    metadata: {},
    installed_by: "user_1",
    installation_id: "42",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  }
}

function outboxSpy() {
  return spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)
}

/** Route-event inserts recorded on the spy, as {eventType, payload} tuples. */
function routeEvents(
  spy: ReturnType<typeof outboxSpy>
): Array<{ eventType: string; payload: Record<string, unknown> }> {
  return spy.mock.calls.map((call) => ({
    eventType: call[1] as string,
    payload: call[2] as unknown as Record<string, unknown>,
  }))
}

afterEach(() => {
  mock.restore()
})

const FUTURE_ISO = new Date(Date.now() + 3_600_000).toISOString()

function encryptedGithubCredentials(installationId: number): Record<string, unknown> {
  return encryptJson(
    SECRET,
    { installationId, accessToken: "tok", tokenExpiresAt: FUTURE_ISO },
    { workspaceId: "ws_1", provider: "github" }
  )
}

/** An active install row with decryptable, non-expiring credentials and metadata. */
function activeGithubInstall(installationId: string, metadata: Record<string, unknown> = {}): Record<string, unknown> {
  return githubRow({
    id: `wsi_${installationId}`,
    installation_id: installationId,
    credentials: encryptedGithubCredentials(Number(installationId)),
    metadata,
    version: 1,
  })
}

const NEAR_LIMIT = { rateLimitRemaining: 5, rateLimitResetAt: FUTURE_ISO }

describe("getGithubClient owner-aware resolution", () => {
  function serviceWithInstalls(rows: Array<Record<string, unknown>>): WorkspaceIntegrationService {
    // recordingPool returns the same rows for the listByWorkspaceAndProvider SELECT.
    return new WorkspaceIntegrationService({
      pool: recordingPool(rows).pool,
      github: githubEnabled,
      linear: linearDisabled,
      region: "eu-north-1",
    })
  }

  it("uses the install whose account login matches repoOwner (case-insensitive)", async () => {
    const service = serviceWithInstalls([
      activeGithubInstall("100", { organizationName: "Acme" }),
      activeGithubInstall("200", { organizationName: "other" }),
    ])
    const client = await service.getGithubClient("ws_1", { repoOwner: "acme" })
    expect(client).toBeInstanceOf(GitHubClient)
  })

  it("returns null (hard breaker) when the owner-matched install is throttled, never borrowing a sibling", async () => {
    const service = serviceWithInstalls([
      activeGithubInstall("100", { organizationName: "acme", ...NEAR_LIMIT }),
      activeGithubInstall("200", { organizationName: "other" }),
    ])
    const client = await service.getGithubClient("ws_1", {
      repoOwner: "acme",
      allowUnauthenticatedFallback: true,
    })
    expect(client).toBeNull()
  })

  it("falls through to any non-throttled install when no login matches", async () => {
    const service = serviceWithInstalls([
      activeGithubInstall("100", { organizationName: "acme" }),
      activeGithubInstall("200", { organizationName: "other" }),
    ])
    const client = await service.getGithubClient("ws_1", { repoOwner: "nobody" })
    expect(client).toBeInstanceOf(GitHubClient)
  })

  it("returns null when every active install is throttled (breaker), even with fallback allowed", async () => {
    const service = serviceWithInstalls([
      activeGithubInstall("100", { organizationName: "acme", ...NEAR_LIMIT }),
      activeGithubInstall("200", { organizationName: "other", ...NEAR_LIMIT }),
    ])
    const client = await service.getGithubClient("ws_1", { allowUnauthenticatedFallback: true })
    expect(client).toBeNull()
  })

  it("falls back to anonymous when no install yields a client and fallback is allowed", async () => {
    // Undecryptable credentials → no client parsed; not throttled → fallback path.
    const service = serviceWithInstalls([githubRow({ installation_id: "100", credentials: { garbage: true } })])
    const client = await service.getGithubClient("ws_1", { allowUnauthenticatedFallback: true })
    expect(client).toBeInstanceOf(GitHubClient)
  })

  it("returns null (no fallback flag) when there are no active installs", async () => {
    const service = serviceWithInstalls([githubRow({ status: "inactive" })])
    expect(await service.getGithubClient("ws_1", { repoOwner: "acme" })).toBeNull()
  })
})

describe("completeGithubInstallation account types", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function stubInstallationNetwork(service: WorkspaceIntegrationService, accountType: string, login: string): void {
    spyOn(service as unknown as { getAppOctokit: () => unknown }, "getAppOctokit").mockReturnValue({
      request: async (route: string) => {
        if (route.startsWith("GET /app/installations")) {
          return {
            data: {
              account: { type: accountType, login },
              repository_selection: "all",
              permissions: {},
            },
          }
        }
        return { data: { token: "tok", expires_at: FUTURE_ISO, permissions: {} } }
      },
    })
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ repositories: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch
  }

  function completeInstall(service: WorkspaceIntegrationService, rawId: string): Promise<void> {
    return (
      service as unknown as {
        completeGithubInstallation(workspaceId: string, userId: string, rawId: string): Promise<void>
      }
    ).completeGithubInstallation("ws_1", "user_1", rawId)
  }

  it("accepts a personal (User) account and persists accountType into metadata", async () => {
    const { pool } = recordingPool([])
    spyOn(WorkspaceIntegrationRepository, "lockWorkspace").mockResolvedValue(undefined)
    spyOn(WorkspaceIntegrationRepository, "listByWorkspaceAndProvider").mockResolvedValue([])
    const upsertSpy = spyOn(WorkspaceIntegrationRepository, "upsert").mockImplementation(async (_c, params) => ({
      id: params.id,
      workspaceId: params.workspaceId,
      provider: params.provider,
      status: params.status,
      credentials: params.credentials,
      metadata: params.metadata,
      installedBy: params.installedBy,
      installationId: params.installationId ?? null,
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    }))
    outboxSpy()
    const service = new WorkspaceIntegrationService({
      pool,
      github: githubEnabled,
      linear: linearDisabled,
      region: "eu-north-1",
    })
    stubInstallationNetwork(service, "User", "kristofferremback")

    await completeInstall(service, "555")

    const params = upsertSpy.mock.calls[0][1]
    expect(params.status).toBe("active")
    expect(params.installationId).toBe("555")
    expect((params.metadata as { accountType?: unknown }).accountType).toBe("User")
    expect((params.metadata as { organizationName?: unknown }).organizationName).toBe("kristofferremback")
  })

  it("accepts an Organization account (no org-required throw)", async () => {
    const { pool } = recordingPool([])
    spyOn(WorkspaceIntegrationRepository, "lockWorkspace").mockResolvedValue(undefined)
    spyOn(WorkspaceIntegrationRepository, "listByWorkspaceAndProvider").mockResolvedValue([])
    const upsertSpy = spyOn(WorkspaceIntegrationRepository, "upsert").mockImplementation(async (_c, params) => ({
      id: params.id,
      workspaceId: params.workspaceId,
      provider: params.provider,
      status: params.status,
      credentials: params.credentials,
      metadata: params.metadata,
      installedBy: params.installedBy,
      installationId: params.installationId ?? null,
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    }))
    outboxSpy()
    const service = new WorkspaceIntegrationService({
      pool,
      github: githubEnabled,
      linear: linearDisabled,
      region: "eu-north-1",
    })
    stubInstallationNetwork(service, "Organization", "acme")

    await completeInstall(service, "777")

    const params = upsertSpy.mock.calls[0][1]
    expect((params.metadata as { accountType?: unknown }).accountType).toBe("Organization")
  })
})

describe("disconnectGithubIntegration route unregistration", () => {
  it("emits a github_route:unregister event with the plaintext installation id", async () => {
    const { pool } = recordingPool([githubRow()])
    const spy = outboxSpy()
    const service = new WorkspaceIntegrationService({
      pool,
      github: githubEnabled,
      linear: linearDisabled,
      region: "eu-north-1",
    })

    await service.disconnectGithubInstallation("ws_1", "wsi_1")

    expect(routeEvents(spy)).toEqual([
      {
        eventType: "github_route:unregister",
        payload: { workspaceId: "ws_1", installationId: "42", region: "eu-north-1" },
      },
    ])
  })

  it("falls back to decrypting credentials for the id when the column is null", async () => {
    const credentials = encryptJson(
      SECRET,
      { installationId: 99, accessToken: "tok", tokenExpiresAt: new Date().toISOString() },
      { workspaceId: "ws_1", provider: "github" }
    )
    const { pool } = recordingPool([githubRow({ installation_id: null, credentials })])
    const spy = outboxSpy()
    const service = new WorkspaceIntegrationService({
      pool,
      github: githubEnabled,
      linear: linearDisabled,
      region: "eu-north-1",
    })

    await service.disconnectGithubInstallation("ws_1", "wsi_1")

    expect(routeEvents(spy)).toEqual([
      {
        eventType: "github_route:unregister",
        payload: { workspaceId: "ws_1", installationId: "99", region: "eu-north-1" },
      },
    ])
  })

  it("captures the id before the row is cleared, committing the unregister event with the UPDATE", async () => {
    // The old code unregistered BEFORE the clear so a pre-backfill row (id only in
    // credentials) didn't lose its id. That ordering concern dissolves now: the id
    // is resolved from the pre-clear record and the event is committed in the SAME
    // transaction as the credential-wiping UPDATE, so both land or neither does.
    const credentials = encryptJson(
      SECRET,
      { installationId: 55, accessToken: "tok", tokenExpiresAt: new Date().toISOString() },
      { workspaceId: "ws_1", provider: "github" }
    )
    const { pool, calls } = recordingPool([githubRow({ installation_id: null, credentials })])
    const spy = outboxSpy()
    const service = new WorkspaceIntegrationService({
      pool,
      github: githubEnabled,
      linear: linearDisabled,
      region: "eu-north-1",
    })

    await service.disconnectGithubInstallation("ws_1", "wsi_1")

    const update = calls.find((c) => c.text.includes("UPDATE workspace_integrations"))
    expect(update).toBeDefined()
    expect(routeEvents(spy)).toEqual([
      {
        eventType: "github_route:unregister",
        payload: { workspaceId: "ws_1", installationId: "55", region: "eu-north-1" },
      },
    ])
  })

  it("does not deactivate or unregister when the integration was replaced after the read", async () => {
    let queryCount = 0
    const calls: QueryCall[] = []
    const pool = {
      query: async (query: unknown, values: unknown[] = []) => {
        const text = typeof query === "string" ? query : ((query as { text?: string })?.text ?? "")
        calls.push({ text, values })
        queryCount += 1
        if (text.includes("UPDATE workspace_integrations")) return { rows: [], rowCount: 0 }
        return { rows: queryCount === 1 ? [githubRow({ installation_id: "42" })] : [], rowCount: 1 }
      },
      release: () => {},
    } as unknown as Pool
    const spy = outboxSpy()
    const service = new WorkspaceIntegrationService({
      pool,
      github: githubEnabled,
      linear: linearDisabled,
      region: "eu-north-1",
    })

    await service.disconnectGithubInstallation("ws_1", "wsi_1")

    const update = calls.find((call) => call.text.includes("UPDATE workspace_integrations"))
    expect(update?.values).toContain("42")
    expect(routeEvents(spy)).toEqual([])
  })

  it("does NOT version-CAS, so a concurrent background version bump can't no-op the disconnect (asymmetry)", async () => {
    // Lifecycle writes express absolute user intent: the guarded UPDATE is scoped
    // to the installation id but leaves the version guard ($10) NULL, so a
    // concurrent rate-limit/refresh version bump does not make the disconnect miss.
    const { pool, calls } = recordingPool([githubRow({ installation_id: "42", version: 9 })])
    const spy = outboxSpy()
    const service = new WorkspaceIntegrationService({
      pool,
      github: githubEnabled,
      linear: linearDisabled,
      region: "eu-north-1",
    })

    await service.disconnectGithubInstallation("ws_1", "wsi_1")

    const update = calls.find((c) => c.text.includes("UPDATE workspace_integrations"))
    expect(update?.values).toContain("inactive")
    // $10 (expectedVersion) is null → no version CAS on the lifecycle write.
    expect(update?.values[9]).toBeNull()
    expect(routeEvents(spy)).toEqual([
      {
        eventType: "github_route:unregister",
        payload: { workspaceId: "ws_1", installationId: "42", region: "eu-north-1" },
      },
    ])
  })

  it("emits no route event when no region is configured (local dev)", async () => {
    const { pool } = recordingPool([githubRow()])
    const spy = outboxSpy()
    const service = new WorkspaceIntegrationService({
      pool,
      github: githubEnabled,
      linear: linearDisabled,
      region: null,
    })

    await service.disconnectGithubInstallation("ws_1", "wsi_1")

    expect(spy).not.toHaveBeenCalled()
  })
})

describe("GitHub installation route lifecycle (additive)", () => {
  it("serializes on the workspace lock and registers the new install WITHOUT unregistering siblings", async () => {
    // Installs are additive (N rows per workspace): connecting installation 77
    // must not unregister an existing installation 42. Only a register event fires.
    const { pool } = recordingPool([])
    const install: UpsertWorkspaceIntegrationParams = {
      id: "wsi_2",
      workspaceId: "ws_1",
      provider: "github",
      status: "active",
      credentials: {},
      metadata: {},
      installedBy: "user_1",
      installationId: "77",
    }
    const lockSpy = spyOn(WorkspaceIntegrationRepository, "lockWorkspace").mockResolvedValue(undefined)
    const findSpy = spyOn(WorkspaceIntegrationRepository, "findByWorkspaceAndProvider")
    spyOn(WorkspaceIntegrationRepository, "upsert").mockResolvedValue({
      id: "wsi_2",
      workspaceId: "ws_1",
      provider: "github",
      status: "active",
      credentials: {},
      metadata: {},
      installedBy: "user_1",
      installationId: "77",
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const spy = outboxSpy()
    const service = new WorkspaceIntegrationService({
      pool,
      github: githubEnabled,
      linear: linearDisabled,
      region: "eu-north-1",
    })

    await (
      service as unknown as {
        persistGithubIntegration(
          params: UpsertWorkspaceIntegrationParams,
          installationScope: string | null,
          routeInstallationId: string
        ): Promise<WorkspaceIntegrationRecord>
      }
    ).persistGithubIntegration(install, null, "77")

    expect(lockSpy).toHaveBeenCalledWith(pool, "ws_1")
    // The lifecycle branch no longer looks up the previous row to unregister it.
    expect(findSpy).not.toHaveBeenCalled()
    expect(routeEvents(spy)).toEqual([
      {
        eventType: "github_route:register",
        payload: { workspaceId: "ws_1", installationId: "77", region: "eu-north-1" },
      },
    ])
  })
})

describe("backfillGithubRoute", () => {
  it("emits a github_route:register event under a status='active' guard", async () => {
    const { pool, calls } = recordingPool([githubRow({ installation_id: "42" })])
    const spy = outboxSpy()
    const service = new WorkspaceIntegrationService({
      pool,
      github: githubEnabled,
      linear: linearDisabled,
      region: "eu-north-1",
    })

    const result = await service.backfillGithubRoute("ws_1")

    expect(result).toEqual({ processed: 1 })
    expect(routeEvents(spy)).toEqual([
      {
        eventType: "github_route:register",
        payload: { workspaceId: "ws_1", installationId: "42", region: "eu-north-1" },
      },
    ])
    // The persist is guarded on status='active' AND on the installation id being
    // NULL-or-this-value (finding #2), so neither a concurrent disconnect nor a
    // reconnect-to-B is clobbered.
    const update = calls.find((c) => c.text.includes("UPDATE workspace_integrations"))
    expect(update).toBeDefined()
    expect(update?.values).toContain("active")
    expect(update?.values).toContain("42")
  })

  it("emits no event when a concurrent disconnect wins the guarded update", async () => {
    // SELECT sees an active row, but the guarded UPDATE matches zero rows —
    // simulating a disconnect (or reconnect-to-B) that no-ops this write.
    const calls: QueryCall[] = []
    const pool = {
      query: async (query: unknown, values: unknown[] = []) => {
        const text = typeof query === "string" ? query : ((query as { text?: string })?.text ?? "")
        calls.push({ text, values })
        if (text.includes("UPDATE workspace_integrations")) {
          return { rows: [], rowCount: 0 }
        }
        return { rows: [githubRow({ installation_id: "42" })], rowCount: 1 }
      },
      release: () => {},
    } as unknown as Pool
    const spy = outboxSpy()
    const service = new WorkspaceIntegrationService({
      pool,
      github: githubEnabled,
      linear: linearDisabled,
      region: "eu-north-1",
    })

    const result = await service.backfillGithubRoute("ws_1")

    expect(result).toEqual({ processed: 0 })
    expect(spy).not.toHaveBeenCalled()
  })

  // NOTE: the former "undoes the route when a disconnect interleaves between the
  // guarded update and register" test is deleted. The register is now committed in
  // the same transaction as the guarded update and outbox events are ordered, so a
  // later disconnect's unregister event is applied after this register — the
  // post-register re-read + compensating unregister no longer exists.

  it("writes the column from decrypted credentials then emits the register event", async () => {
    const credentials = encryptJson(
      SECRET,
      { installationId: 77, accessToken: "tok", tokenExpiresAt: new Date().toISOString() },
      { workspaceId: "ws_1", provider: "github" }
    )
    const { pool, calls } = recordingPool([githubRow({ installation_id: null, credentials })])
    const spy = outboxSpy()
    const service = new WorkspaceIntegrationService({
      pool,
      github: githubEnabled,
      linear: linearDisabled,
      region: "eu-north-1",
    })

    const result = await service.backfillGithubRoute("ws_1")

    expect(result).toEqual({ processed: 1 })
    const update = calls.find((c) => c.text.includes("UPDATE workspace_integrations"))
    expect(update).toBeDefined()
    expect(update?.values).toContain("77")
    expect(routeEvents(spy)).toEqual([
      {
        eventType: "github_route:register",
        payload: { workspaceId: "ws_1", installationId: "77", region: "eu-north-1" },
      },
    ])
  })

  it("no-ops for an inactive integration", async () => {
    const { pool } = recordingPool([githubRow({ status: "inactive" })])
    const spy = outboxSpy()
    const service = new WorkspaceIntegrationService({
      pool,
      github: githubEnabled,
      linear: linearDisabled,
      region: "eu-north-1",
    })

    const result = await service.backfillGithubRoute("ws_1")

    expect(result).toEqual({ processed: 0 })
    expect(spy).not.toHaveBeenCalled()
  })

  it("skips a row whose credentials cannot be decrypted", async () => {
    const { pool } = recordingPool([githubRow({ installation_id: null, credentials: { garbage: true } })])
    const spy = outboxSpy()
    const service = new WorkspaceIntegrationService({
      pool,
      github: githubEnabled,
      linear: linearDisabled,
      region: "eu-north-1",
    })

    const result = await service.backfillGithubRoute("ws_1")

    expect(result).toEqual({ processed: 0 })
    expect(spy).not.toHaveBeenCalled()
  })
})

describe("syncGithubRepositories version-CAS retry (INV-66)", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function githubCredentials(): Record<string, unknown> {
    return encryptJson(
      SECRET,
      { installationId: 42, accessToken: "tok", tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString() },
      { workspaceId: "ws_1", provider: "github" }
    )
  }

  // Fake the app octokit (token mint) so no JWT is signed, and stub fetch so the
  // `GET /installation/repositories` Octokit inside `listInstallationRepositories`
  // resolves to an empty list — no real network.
  function stubGithubNetwork(service: WorkspaceIntegrationService): void {
    spyOn(service as unknown as { getAppOctokit: () => unknown }, "getAppOctokit").mockReturnValue({
      request: async () => ({
        data: { token: "fresh-tok", expires_at: new Date(Date.now() + 3_600_000).toISOString(), permissions: {} },
      }),
    })
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ repositories: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch
  }

  it("re-reads and retries once, then throws the 409 conflict when the second CAS also loses", async () => {
    // Every UPDATE misses (version advanced concurrently). SELECTs return an
    // active row. Expect exactly two UPDATE attempts (initial + one retry), then throw.
    let updateCount = 0
    const calls: QueryCall[] = []
    const pool = {
      query: async (query: unknown, values: unknown[] = []) => {
        const text = typeof query === "string" ? query : ((query as { text?: string })?.text ?? "")
        calls.push({ text, values })
        if (text.includes("UPDATE workspace_integrations")) {
          updateCount += 1
          return { rows: [], rowCount: 0 }
        }
        return {
          rows: [githubRow({ installation_id: "42", credentials: githubCredentials(), version: 5 })],
          rowCount: 1,
        }
      },
      release: () => {},
    } as unknown as Pool
    const service = new WorkspaceIntegrationService({
      pool,
      github: githubEnabled,
      linear: linearDisabled,
      region: "eu-north-1",
    })
    stubGithubNetwork(service)

    let caught: unknown
    try {
      await service.syncGithubRepositories("ws_1", "wsi_1")
    } catch (error) {
      caught = error
    }

    expect((caught as { status?: number }).status).toBe(409)
    expect((caught as { code?: string }).code).toBe("GITHUB_INTEGRATION_NOT_ACTIVE")
    expect(updateCount).toBe(2)
  })

  it("succeeds when the retry against the re-read version wins", async () => {
    let updateCount = 0
    const pool = {
      query: async (query: unknown) => {
        const text = typeof query === "string" ? query : ((query as { text?: string })?.text ?? "")
        if (text.includes("UPDATE workspace_integrations")) {
          updateCount += 1
          // First CAS loses; the retry (against the re-read version) wins.
          if (updateCount === 1) return { rows: [], rowCount: 0 }
          return { rows: [githubRow({ installation_id: "42", version: 7 })], rowCount: 1 }
        }
        return {
          rows: [githubRow({ installation_id: "42", credentials: githubCredentials(), version: 5 })],
          rowCount: 1,
        }
      },
      release: () => {},
    } as unknown as Pool
    const service = new WorkspaceIntegrationService({
      pool,
      github: githubEnabled,
      linear: linearDisabled,
      region: "eu-north-1",
    })
    stubGithubNetwork(service)

    const result = await service.syncGithubRepositories("ws_1", "wsi_1")

    expect(result.status).toBe("active")
    expect(updateCount).toBe(2)
  })
})

describe("GitHub repository reconfiguration", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  /**
   * Stub both app-JWT routes distinctly: the installation read (identity +
   * repository grant, what a reconfigure on GitHub changes) and the token mint.
   * `fetch` serves the installation-token Octokit's repository listing.
   */
  function stubReconfiguredInstallation(
    service: WorkspaceIntegrationService,
    installation: Record<string, unknown>,
    repositories: Array<{ full_name: string; private: boolean }>
  ): void {
    spyOn(service as unknown as { getAppOctokit: () => unknown }, "getAppOctokit").mockReturnValue({
      request: async (route: string) => {
        if (route.startsWith("GET /app/installations")) return { data: installation }
        return {
          data: { token: "fresh-tok", expires_at: FUTURE_ISO, permissions: installation.permissions ?? {} },
        }
      },
    })
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ repositories }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch
  }

  function poolCapturingUpdate(selectRow: Record<string, unknown>): {
    pool: Pool
    updates: QueryCall[]
  } {
    const updates: QueryCall[] = []
    const pool = {
      query: async (query: unknown, values: unknown[] = []) => {
        const text = typeof query === "string" ? query : ((query as { text?: string })?.text ?? "")
        if (text.includes("UPDATE workspace_integrations")) {
          updates.push({ text, values })
          return { rows: [{ ...selectRow, metadata: JSON.parse(String(values[5])) }], rowCount: 1 }
        }
        return { rows: [selectRow], rowCount: 1 }
      },
      release: () => {},
    } as unknown as Pool
    return { pool, updates }
  }

  function makeService(pool: Pool): WorkspaceIntegrationService {
    return new WorkspaceIntegrationService({
      pool,
      github: githubEnabled,
      linear: linearDisabled,
      region: "eu-north-1",
    })
  }

  it("re-reads the installation so a grant narrowed on GitHub replaces the cached snapshot", async () => {
    const row = githubRow({
      installation_id: "42",
      credentials: encryptedGithubCredentials(42),
      metadata: {
        organizationName: "acme",
        accountType: "Organization",
        repositorySelection: "all",
        permissions: {},
        repositories: [{ fullName: "acme/old", private: false }],
        rateLimitRemaining: null,
        rateLimitResetAt: null,
      },
      version: 5,
    })
    const { pool } = poolCapturingUpdate(row)
    const service = makeService(pool)
    stubReconfiguredInstallation(
      service,
      {
        account: { type: "Organization", login: "acme" },
        repository_selection: "selected",
        permissions: { contents: "read" },
        html_url: "https://github.com/organizations/acme/settings/installations/42",
      },
      [{ full_name: "acme/widgets", private: true }]
    )

    const result = await service.syncGithubRepositories("ws_1", "wsi_1")

    expect({
      repositorySelection: result.repositorySelection,
      repositories: result.repositories,
      configurationUrl: result.configurationUrl,
      permissions: result.permissions,
    }).toEqual({
      repositorySelection: "selected",
      repositories: [{ fullName: "acme/widgets", private: true }],
      configurationUrl: "https://github.com/organizations/acme/settings/installations/42",
      permissions: { contents: "read" },
    })
  })

  it("parks the row in error and reports GITHUB_INSTALLATION_GONE when GitHub 404s the installation", async () => {
    const row = githubRow({ installation_id: "42", credentials: encryptedGithubCredentials(42), version: 3 })
    const updates: QueryCall[] = []
    const pool = {
      query: async (query: unknown, values: unknown[] = []) => {
        const text = typeof query === "string" ? query : ((query as { text?: string })?.text ?? "")
        if (text.includes("UPDATE workspace_integrations")) {
          updates.push({ text, values })
          return { rows: [{ ...row, status: "error" }], rowCount: 1 }
        }
        return { rows: [row], rowCount: 1 }
      },
      release: () => {},
    } as unknown as Pool
    const service = makeService(pool)
    spyOn(service as unknown as { getAppOctokit: () => unknown }, "getAppOctokit").mockReturnValue({
      request: async () => {
        throw Object.assign(new Error("Not Found"), { status: 404 })
      },
    })

    let caught: unknown
    try {
      await service.syncGithubRepositories("ws_1", "wsi_1")
    } catch (error) {
      caught = error
    }

    expect((caught as { status?: number; code?: string }).code).toBe("GITHUB_INSTALLATION_GONE")
    expect((caught as { status?: number }).status).toBe(409)
    // status='error', scoped to installation 42, guarded on the row still being active
    expect(updates).toHaveLength(1)
    expect([updates[0].values[2], updates[0].values[3], updates[0].values[8]]).toEqual(["42", "error", "active"])
  })

  it("refreshes every workspace on the installation when GitHub reports a grant change", async () => {
    const rows = [
      githubRow({
        id: "wsi_a",
        workspace_id: "ws_a",
        installation_id: "42",
        credentials: encryptJson(
          SECRET,
          { installationId: 42, accessToken: "tok", tokenExpiresAt: FUTURE_ISO },
          { workspaceId: "ws_a", provider: "github" }
        ),
      }),
      githubRow({
        id: "wsi_b",
        workspace_id: "ws_b",
        installation_id: "42",
        credentials: encryptJson(
          SECRET,
          { installationId: 42, accessToken: "tok", tokenExpiresAt: FUTURE_ISO },
          { workspaceId: "ws_b", provider: "github" }
        ),
      }),
    ]
    const updates: QueryCall[] = []
    const pool = {
      query: async (query: unknown, values: unknown[] = []) => {
        const text = typeof query === "string" ? query : ((query as { text?: string })?.text ?? "")
        if (text.includes("UPDATE workspace_integrations")) {
          updates.push({ text, values })
          return { rows: [rows[updates.length - 1]], rowCount: 1 }
        }
        return { rows, rowCount: rows.length }
      },
      release: () => {},
    } as unknown as Pool
    const service = makeService(pool)
    stubReconfiguredInstallation(
      service,
      { account: { type: "Organization", login: "acme" }, repository_selection: "selected", permissions: {} },
      [{ full_name: "acme/widgets", private: true }]
    )

    const result = await service.refreshGithubInstallationRepositories("42")

    expect(result.refreshedWorkspaceIds).toEqual(["ws_a", "ws_b"])
    expect(updates.map((call) => call.values[0])).toEqual(["ws_a", "ws_b"])
  })

  it("rethrows so the delivery retries when the refresh fails on a transient GitHub error", async () => {
    const row = githubRow({ installation_id: "42", credentials: encryptedGithubCredentials(42) })
    const { pool } = recordingPool([row])
    const service = makeService(pool)
    spyOn(service as unknown as { getAppOctokit: () => unknown }, "getAppOctokit").mockReturnValue({
      request: async () => {
        throw Object.assign(new Error("Bad gateway"), { status: 502 })
      },
    })

    await expect(service.refreshGithubInstallationRepositories("42")).rejects.toThrow(/retrying delivery/)
  })

  it("derives a configuration URL for installs that predate capturing GitHub's own", async () => {
    const { pool } = recordingPool([
      githubRow({
        id: "wsi_org",
        installation_id: "42",
        metadata: { organizationName: "acme", accountType: "Organization" },
      }),
      githubRow({
        id: "wsi_user",
        installation_id: "77",
        metadata: { organizationName: "kris", accountType: "User" },
      }),
      githubRow({ id: "wsi_unknown", installation_id: "99", metadata: {} }),
    ])
    const service = makeService(pool)

    const installs = await service.listGithubInstallations("ws_1")

    expect(installs.map((install) => install.configurationUrl)).toEqual([
      "https://github.com/organizations/acme/settings/installations/42",
      "https://github.com/settings/installations/77",
      null,
    ])
  })
})

describe("listActiveWorkspaceIdsForInstallation", () => {
  it("returns every active workspace on the installation, scoped by (provider, installation_id, active)", async () => {
    const { pool, calls } = recordingPool([
      githubRow({ id: "wsi_1", workspace_id: "ws_1" }),
      githubRow({ id: "wsi_2", workspace_id: "ws_2" }),
    ])
    const service = new WorkspaceIntegrationService({
      pool,
      github: githubEnabled,
      linear: linearDisabled,
      region: "eu-north-1",
    })

    const workspaceIds = await service.listActiveWorkspaceIdsForInstallation("42")

    expect(workspaceIds).toEqual(["ws_1", "ws_2"])
    const select = calls.find((c) => c.text.includes("SELECT * FROM workspace_integrations"))
    expect(select?.text).toContain("installation_id")
    expect(select?.text).toContain("status = $3")
    expect(select?.values).toEqual(["github", "42", "active"])
  })
})

describe("deactivateInstallation", () => {
  it("marks each workspace's integration inactive and emits its unregister event", async () => {
    const { pool, calls } = recordingPool([githubRow({ workspace_id: "ws_1" })])
    const spy = outboxSpy()
    const service = new WorkspaceIntegrationService({
      pool,
      github: githubEnabled,
      linear: linearDisabled,
      region: "eu-north-1",
    })

    const result = await service.deactivateInstallation("42")

    expect(result).toEqual({ deactivatedWorkspaceIds: ["ws_1"] })
    const update = calls.find((c) => c.text.includes("UPDATE workspace_integrations"))
    expect(update?.values).toContain("inactive")
    // Guarded on active AND the exact installation id (finding #2) so a concurrent
    // reconnect-to-B isn't clobbered.
    expect(update?.values).toContain("active")
    expect(update?.values).toContain("42")
    expect(routeEvents(spy)).toEqual([
      {
        eventType: "github_route:unregister",
        payload: { workspaceId: "ws_1", installationId: "42", region: "eu-north-1" },
      },
    ])
  })

  it("does not deactivate or emit when the guarded update no-ops (row now on installation B)", async () => {
    // listActiveByInstallationId returned an A row, but the guarded UPDATE (exact
    // installation-id match) matches zero rows — the row disconnected + reconnected
    // to B in between. Deleting A must not touch B: no flip, no unregister event.
    const calls: QueryCall[] = []
    const pool = {
      query: async (query: unknown, values: unknown[] = []) => {
        const text = typeof query === "string" ? query : ((query as { text?: string })?.text ?? "")
        calls.push({ text, values })
        if (text.includes("UPDATE workspace_integrations")) {
          return { rows: [], rowCount: 0 }
        }
        return { rows: [githubRow({ workspace_id: "ws_1" })], rowCount: 1 }
      },
      release: () => {},
    } as unknown as Pool
    const spy = outboxSpy()
    const service = new WorkspaceIntegrationService({
      pool,
      github: githubEnabled,
      linear: linearDisabled,
      region: "eu-north-1",
    })

    const result = await service.deactivateInstallation("42")

    expect(result).toEqual({ deactivatedWorkspaceIds: [] })
    expect(spy).not.toHaveBeenCalled()
  })

  it("no-ops with no active integrations", async () => {
    const { pool } = recordingPool([])
    const spy = outboxSpy()
    const service = new WorkspaceIntegrationService({
      pool,
      github: githubEnabled,
      linear: linearDisabled,
      region: "eu-north-1",
    })

    const result = await service.deactivateInstallation("42")

    expect(result).toEqual({ deactivatedWorkspaceIds: [] })
    expect(spy).not.toHaveBeenCalled()
  })
})

describe("GitHub metadata write guards", () => {
  const metadata = {
    organizationName: "acme",
    accountType: "Organization" as const,
    repositorySelection: "all" as const,
    configurationUrl: null,
    permissions: {},
    repositories: [],
    rateLimitRemaining: null,
    rateLimitResetAt: null,
  }

  it("guards rate-limit metadata on the client's observed installation and version", async () => {
    const { pool, calls } = recordingPool([githubRow({ installation_id: "42", version: 8 })])
    const service = new WorkspaceIntegrationService({
      pool,
      github: githubEnabled,
      linear: linearDisabled,
      region: "eu-north-1",
    })

    const result = await service.updateGithubRateLimitMetadata("ws_1", metadata, "42", 100, null, 7)

    expect(result.metadata.rateLimitRemaining).toBe(100)
    // A win returns the row's new version so a reused client can advance its cached
    // generation instead of self-colliding on the frozen one.
    expect(result.version).toBe(8)
    const update = calls.find((call) => call.text.includes("UPDATE workspace_integrations"))
    expect(update?.text).toContain("version = version + 1")
    expect(update?.text).toContain("version = $10")
    expect(update?.values).toContain("active")
    expect(update?.values).toContain("42")
    // Version-CAS: the observed generation is the last positional param ($10).
    expect(update?.values[9]).toBe(7)
  })

  it("keeps the client's prior metadata when a replacement wins the guard", async () => {
    const { pool } = recordingPool([])
    const service = new WorkspaceIntegrationService({
      pool,
      github: githubEnabled,
      linear: linearDisabled,
      region: "eu-north-1",
    })

    const result = await service.updateGithubRateLimitMetadata("ws_1", metadata, "42", 100, null, 7)
    expect(result.metadata).toBe(metadata)
    // A loss returns null version — the client keeps its cached version and defers
    // to the concurrent writer that actually advanced the row.
    expect(result.version).toBeNull()
  })

  it("returns prior metadata (loses) when a newer same-installation write advanced the version", async () => {
    // SELECTs would show an active row, but the version-CAS UPDATE matches 0 rows
    // because a concurrent repo-sync already bumped the version — the stale
    // rate-limit write must NOT clobber the newer repositories list.
    const { pool, calls } = guardMissPoolShared([])
    const service = new WorkspaceIntegrationService({
      pool,
      github: githubEnabled,
      linear: linearDisabled,
      region: "eu-north-1",
    })

    const result = await service.updateGithubRateLimitMetadata("ws_1", metadata, "42", 100, null, 3)

    expect(result.metadata).toBe(metadata)
    expect(result.version).toBeNull()
    const update = calls.find((call) => call.text.includes("UPDATE workspace_integrations"))
    expect(update?.values[9]).toBe(3)
  })
})

describe("persistGithubIntegration token-refresh path (non-route)", () => {
  const refreshParams: UpsertWorkspaceIntegrationParams = {
    id: "wsi_1",
    workspaceId: "ws_1",
    provider: "github",
    status: "active",
    credentials: { blob: "enc" },
    metadata: { organizationName: "acme" },
    installedBy: "user_1",
    installationId: "42",
  }

  function persist(
    service: WorkspaceIntegrationService,
    params: UpsertWorkspaceIntegrationParams,
    routeInstallationId?: string,
    expectedVersion?: number
  ): Promise<WorkspaceIntegrationRecord | null> {
    return (
      service as unknown as {
        persistGithubIntegration(
          p: UpsertWorkspaceIntegrationParams,
          scope: string | null,
          r?: string,
          v?: number
        ): Promise<WorkspaceIntegrationRecord | null>
      }
    ).persistGithubIntegration(params, params.installationId ?? null, routeInstallationId, expectedVersion)
  }

  it("uses the guarded UPDATE (not a blind upsert) and persists a normal refresh", async () => {
    const { pool, calls } = recordingPool([githubRow({ installation_id: "42" })])
    const spy = outboxSpy()
    const lockSpy = spyOn(WorkspaceIntegrationRepository, "lockWorkspace").mockResolvedValue(undefined)
    const service = new WorkspaceIntegrationService({
      pool,
      github: githubEnabled,
      linear: linearDisabled,
      region: "eu-north-1",
    })

    const result = await persist(service, refreshParams)

    expect(result).not.toBeNull()
    const update = calls.find((c) => c.text.includes("UPDATE workspace_integrations"))
    expect(update).toBeDefined()
    // Guard values: expectedStatus 'active' and installationScope '42'.
    expect(update?.values).toContain("active")
    expect(update?.values).toContain("42")
    // The non-route path never locks the workspace, upserts, or emits a route event.
    expect(lockSpy).not.toHaveBeenCalled()
    expect(calls.find((c) => c.text.includes("INSERT INTO workspace_integrations"))).toBeUndefined()
    expect(spy).not.toHaveBeenCalled()
  })

  it("returns null (does not resurrect) when a concurrent disconnect wins the guarded update", async () => {
    // The row is mid-disconnect: the guarded UPDATE (status='active') matches 0 rows,
    // so the refresh must NOT re-INSERT an ACTIVE row with no CP route.
    const calls: QueryCall[] = []
    const pool = {
      query: async (query: unknown, values: unknown[] = []) => {
        const text = typeof query === "string" ? query : ((query as { text?: string })?.text ?? "")
        calls.push({ text, values })
        return { rows: [], rowCount: 0 }
      },
      release: () => {},
    } as unknown as Pool
    const service = new WorkspaceIntegrationService({
      pool,
      github: githubEnabled,
      linear: linearDisabled,
      region: "eu-north-1",
    })

    const result = await persist(service, refreshParams)

    expect(result).toBeNull()
    // A blind upsert would have INSERTed; the guarded path only ran an UPDATE.
    expect(calls.find((c) => c.text.includes("INSERT INTO workspace_integrations"))).toBeUndefined()
  })

  it("returns null (does not clobber B) when the row reconnected to a different installation", async () => {
    // A refresh for installation A lands after the row reconnected to B: the guard
    // carries A's id, the DB row is on B, so the UPDATE matches nothing → null.
    const calls: QueryCall[] = []
    const pool = {
      query: async (query: unknown, values: unknown[] = []) => {
        const text = typeof query === "string" ? query : ((query as { text?: string })?.text ?? "")
        calls.push({ text, values })
        return { rows: [], rowCount: 0 }
      },
      release: () => {},
    } as unknown as Pool
    const service = new WorkspaceIntegrationService({
      pool,
      github: githubEnabled,
      linear: linearDisabled,
      region: "eu-north-1",
    })

    const result = await persist(service, { ...refreshParams, installationId: "42" })

    expect(result).toBeNull()
    const update = calls.find((c) => c.text.includes("UPDATE workspace_integrations"))
    expect(update?.values).toContain("42")
  })

  it("returns null (does not clobber) when a newer same-installation write advanced the version", async () => {
    // A token refresh that read version 4 lands after a concurrent write bumped
    // it: the version-CAS UPDATE matches nothing → null, so the stale credentials
    // + metadata don't overwrite the newer write (INV-66).
    const calls: QueryCall[] = []
    const pool = {
      query: async (query: unknown, values: unknown[] = []) => {
        const text = typeof query === "string" ? query : ((query as { text?: string })?.text ?? "")
        calls.push({ text, values })
        return { rows: [], rowCount: 0 }
      },
      release: () => {},
    } as unknown as Pool
    const service = new WorkspaceIntegrationService({
      pool,
      github: githubEnabled,
      linear: linearDisabled,
      region: "eu-north-1",
    })

    const result = await persist(service, refreshParams, undefined, 4)

    expect(result).toBeNull()
    const update = calls.find((c) => c.text.includes("UPDATE workspace_integrations"))
    expect(update?.text).toContain("version = $10")
    expect(update?.values[9]).toBe(4)
    expect(calls.find((c) => c.text.includes("INSERT INTO workspace_integrations"))).toBeUndefined()
  })
})
