import { describe, it, expect } from "bun:test"
import type { Pool } from "pg"
import { WorkspaceIntegrationService } from "./service"
import type { WorkspaceIntegrationRecord } from "./repository"
import type { LinearIntegrationMetadata } from "./linear-client"
import type { LinearOAuthTokenResponse } from "./linear-oauth"
import { encryptJson } from "./crypto"
import type { GitHubAppConfig, LinearOAuthConfig } from "../../lib/env"

const SECRET = "secret"

const githubDisabled: GitHubAppConfig = {
  enabled: false,
  appId: "",
  appSlug: "",
  privateKey: "",
  integrationSecret: SECRET,
}

const linearEnabled: LinearOAuthConfig = {
  enabled: true,
  clientId: "client",
  clientSecret: "client-secret",
  redirectUri: "https://example.test/callback",
  integrationSecret: SECRET,
}

interface QueryCall {
  text: string
  values: unknown[]
}

/** Records every query and returns a scripted row set for the UPDATE/INSERT. */
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

/** A pool whose UPDATE matches 0 rows (a concurrent disconnect / reconnect won). */
function guardMissPool(selectRows: Array<Record<string, unknown>>): { pool: Pool; calls: QueryCall[] } {
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

function makeService(pool: Pool): WorkspaceIntegrationService {
  return new WorkspaceIntegrationService({ pool, github: githubDisabled, linear: linearEnabled, region: "eu-north-1" })
}

function linearRecord(overrides: Partial<WorkspaceIntegrationRecord> = {}): WorkspaceIntegrationRecord {
  return {
    id: "wsi_1",
    workspaceId: "ws_1",
    provider: "linear",
    status: "active",
    credentials: {},
    metadata: {},
    installedBy: "user_1",
    installationId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function linearMetadata(organizationId: string | null): LinearIntegrationMetadata {
  return {
    organizationId,
    organizationName: "Acme",
    organizationUrlKey: "acme",
    authorizedUser: null,
    rateLimit: {
      requestsRemaining: null,
      requestsResetAt: null,
      complexityRemaining: null,
      complexityResetAt: null,
    },
  }
}

function tokens(): LinearOAuthTokenResponse {
  return {
    accessToken: "at-new",
    refreshToken: "rt-new",
    tokenType: "Bearer",
    expiresIn: 3600,
    scope: "read",
  }
}

function persistLinear(
  service: WorkspaceIntegrationService,
  record: WorkspaceIntegrationRecord,
  metadata: LinearIntegrationMetadata,
  options: { installedByOverride?: string; isInstall: boolean }
): Promise<WorkspaceIntegrationRecord | null> {
  return (
    service as unknown as {
      persistLinearCredentials(
        workspaceId: string,
        record: WorkspaceIntegrationRecord,
        tokens: LinearOAuthTokenResponse,
        metadata: LinearIntegrationMetadata,
        options: { installedByOverride?: string; isInstall: boolean }
      ): Promise<{ record: WorkspaceIntegrationRecord } | null>
    }
  )
    .persistLinearCredentials("ws_1", record, tokens(), metadata, options)
    .then((result) => result?.record ?? null)
}

describe("persistLinearCredentials refresh path (isInstall:false)", () => {
  it("uses a guarded UPDATE carrying active status and the org id, not a blind upsert", async () => {
    const { pool, calls } = recordingPool([{ ...linearRecordRow(), installation_id: "org_123" }])
    const service = makeService(pool)

    const result = await persistLinear(service, linearRecord(), linearMetadata("org_123"), { isInstall: false })

    expect(result).not.toBeNull()
    const update = calls.find((c) => c.text.includes("UPDATE workspace_integrations"))
    expect(update).toBeDefined()
    expect(update?.values).toContain("active")
    expect(update?.values).toContain("org_123")
    expect(calls.find((c) => c.text.includes("INSERT INTO workspace_integrations"))).toBeUndefined()
  })

  it("returns null (does not resurrect) when a concurrent disconnect wins the guard", async () => {
    const { pool, calls } = guardMissPool([])
    const service = makeService(pool)

    const result = await persistLinear(service, linearRecord(), linearMetadata("org_123"), { isInstall: false })

    expect(result).toBeNull()
    // A blind upsert would have INSERTed; the guarded path only ran an UPDATE.
    expect(calls.find((c) => c.text.includes("INSERT INTO workspace_integrations"))).toBeUndefined()
  })
})

describe("persistLinearCredentials install path (isInstall:true)", () => {
  it("upserts and populates installation_id with the Linear org id", async () => {
    const { pool, calls } = recordingPool([{ ...linearRecordRow(), installation_id: "org_123" }])
    const service = makeService(pool)

    const result = await persistLinear(service, linearRecord(), linearMetadata("org_123"), {
      installedByOverride: "user_1",
      isInstall: true,
    })

    expect(result).not.toBeNull()
    const insert = calls.find((c) => c.text.includes("INSERT INTO workspace_integrations"))
    expect(insert).toBeDefined()
    expect(insert?.values).toContain("org_123")
  })
})

describe("updateLinearRateLimitMetadata guards", () => {
  const rateLimit = {
    requestsRemaining: 42,
    requestsResetAt: null,
    complexityRemaining: null,
    complexityResetAt: null,
  }

  it("guards on active status and the org id and returns the next metadata when it lands", async () => {
    const { pool, calls } = recordingPool([{ ...linearRecordRow(), installation_id: "org_123" }])
    const service = makeService(pool)
    const metadata = linearMetadata("org_123")

    const result = await service.updateLinearRateLimitMetadata("ws_1", metadata, rateLimit)

    expect(result.rateLimit.requestsRemaining).toBe(42)
    const update = calls.find((c) => c.text.includes("UPDATE workspace_integrations"))
    expect(update?.values).toContain("active")
    expect(update?.values).toContain("org_123")
  })

  it("keeps the prior metadata when the write lands on a cleared row (guard no-op)", async () => {
    const { pool } = guardMissPool([])
    const service = makeService(pool)
    const metadata = linearMetadata("org_123")

    expect(await service.updateLinearRateLimitMetadata("ws_1", metadata, rateLimit)).toBe(metadata)
  })
})

describe("disconnectLinearIntegration guard", () => {
  it("pins the org id so a disconnect for org A cannot clobber a reconnected org B", async () => {
    // credentials {} → parseLinearCredentials throws → revoke skipped (no network).
    const { pool, calls } = recordingPool([
      { ...linearRecordRow(), installation_id: null, metadata: { organizationId: "org_A" } },
    ])
    const service = makeService(pool)

    await service.disconnectLinearIntegration("ws_1")

    const update = calls.find((c) => c.text.includes("UPDATE workspace_integrations"))
    expect(update).toBeDefined()
    expect(update?.values).toContain("inactive")
    expect(update?.values).toContain("org_A")
  })
})

describe("markLinearIntegrationError guard (via refresh with no refresh token)", () => {
  it("flips to error guarded on active status and the org id", async () => {
    const credentials = encryptJson(
      SECRET,
      {
        accessToken: "at",
        refreshToken: null,
        tokenType: "Bearer",
        tokenExpiresAt: new Date().toISOString(),
        scope: "read",
        actor: "app",
      },
      { workspaceId: "ws_1", provider: "linear" }
    )
    const { pool, calls } = recordingPool([
      { ...linearRecordRow(), credentials, installation_id: "org_123", metadata: { organizationId: "org_123" } },
    ])
    const service = makeService(pool)

    const result = await service.refreshLinearCredentialsForPreview(
      "ws_1",
      linearRecord({ credentials, installationId: "org_123", metadata: { organizationId: "org_123" } })
    )

    expect(result).toBeNull()
    const update = calls.find((c) => c.text.includes("UPDATE workspace_integrations"))
    expect(update).toBeDefined()
    expect(update?.values).toContain("error")
    // expectedStatus 'active' is a guard value; the org id pins identity.
    expect(update?.values).toContain("active")
    expect(update?.values).toContain("org_123")
  })
})

function linearRecordRow(): Record<string, unknown> {
  return {
    id: "wsi_1",
    workspace_id: "ws_1",
    provider: "linear",
    status: "active",
    credentials: {},
    metadata: {},
    installed_by: "user_1",
    installation_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}
