import { describe, it, expect, mock } from "bun:test"
import type { Pool } from "pg"
import { WorkspaceIntegrationService } from "./service"
import { encryptJson } from "./crypto"
import type { ControlPlaneClient } from "../../lib/control-plane-client"
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

// A pool that records every query and returns a scripted row set. `rows` is the
// canned result for SELECT/UPDATE/RETURNING calls — the service only reads the
// first row.
function recordingPool(rows: Array<Record<string, unknown>>): { pool: Pool; calls: QueryCall[] } {
  const calls: QueryCall[] = []
  const pool = {
    // The repository passes squid `sql` objects ({ text, values }); read the
    // real SQL text off `.text` rather than String()-ing the object.
    query: async (query: unknown, values: unknown[] = []) => {
      const text = typeof query === "string" ? query : ((query as { text?: string })?.text ?? "")
      calls.push({ text, values })
      return { rows, rowCount: rows.length }
    },
  } as unknown as Pool
  return { pool, calls }
}

function fakeControlPlaneClient() {
  return {
    registerIntegrationRoute: mock(async () => {}),
    unregisterIntegrationRoute: mock(async () => {}),
  } as unknown as ControlPlaneClient & {
    registerIntegrationRoute: ReturnType<typeof mock>
    unregisterIntegrationRoute: ReturnType<typeof mock>
  }
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

describe("disconnectGithubIntegration route unregistration", () => {
  it("unregisters the CP route using the plaintext installation id", async () => {
    const { pool } = recordingPool([githubRow()])
    const client = fakeControlPlaneClient()
    const service = new WorkspaceIntegrationService({
      pool,
      github: githubEnabled,
      linear: linearDisabled,
      controlPlaneClient: client,
      region: "eu-north-1",
    })

    await service.disconnectGithubIntegration("ws_1")

    expect(client.unregisterIntegrationRoute).toHaveBeenCalledTimes(1)
    expect(client.unregisterIntegrationRoute).toHaveBeenCalledWith({
      provider: "github",
      externalId: "42",
      workspaceId: "ws_1",
    })
  })

  it("falls back to decrypting credentials when the column is null", async () => {
    const credentials = encryptJson(
      SECRET,
      { installationId: 99, accessToken: "tok", tokenExpiresAt: new Date().toISOString() },
      { workspaceId: "ws_1", provider: "github" }
    )
    const { pool } = recordingPool([githubRow({ installation_id: null, credentials })])
    const client = fakeControlPlaneClient()
    const service = new WorkspaceIntegrationService({
      pool,
      github: githubEnabled,
      linear: linearDisabled,
      controlPlaneClient: client,
      region: "eu-north-1",
    })

    await service.disconnectGithubIntegration("ws_1")

    expect(client.unregisterIntegrationRoute).toHaveBeenCalledWith({
      provider: "github",
      externalId: "99",
      workspaceId: "ws_1",
    })
  })

  it("skips unregistration when no control plane is configured (local dev)", async () => {
    const { pool } = recordingPool([githubRow()])
    const service = new WorkspaceIntegrationService({
      pool,
      github: githubEnabled,
      linear: linearDisabled,
      controlPlaneClient: null,
      region: null,
    })

    // No throw, no client — degrade gracefully.
    await service.disconnectGithubIntegration("ws_1")
  })
})

describe("backfillGithubRoute", () => {
  it("registers the route under a status='active' guard", async () => {
    const { pool, calls } = recordingPool([githubRow({ installation_id: "42" })])
    const client = fakeControlPlaneClient()
    const service = new WorkspaceIntegrationService({
      pool,
      github: githubEnabled,
      linear: linearDisabled,
      controlPlaneClient: client,
      region: "eu-north-1",
    })

    const result = await service.backfillGithubRoute("ws_1")

    expect(result).toEqual({ processed: 1 })
    expect(client.registerIntegrationRoute).toHaveBeenCalledWith({
      provider: "github",
      externalId: "42",
      region: "eu-north-1",
      workspaceId: "ws_1",
    })
    // The persist is issued unconditionally but guarded on status='active' so a
    // concurrent disconnect can't be re-registered by a stale backfill.
    const update = calls.find((c) => c.text.includes("UPDATE workspace_integrations"))
    expect(update).toBeDefined()
    expect(update?.values).toContain("active")
  })

  it("does not register when a concurrent disconnect wins the guarded update", async () => {
    // SELECT sees an active row, but the guarded UPDATE matches zero rows —
    // simulating a disconnect that flipped status to 'inactive' in between.
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
    } as unknown as Pool
    const client = fakeControlPlaneClient()
    const service = new WorkspaceIntegrationService({
      pool,
      github: githubEnabled,
      linear: linearDisabled,
      controlPlaneClient: client,
      region: "eu-north-1",
    })

    const result = await service.backfillGithubRoute("ws_1")

    expect(result).toEqual({ processed: 0 })
    expect(client.registerIntegrationRoute).not.toHaveBeenCalled()
  })

  it("writes the column from decrypted credentials then registers the route", async () => {
    const credentials = encryptJson(
      SECRET,
      { installationId: 77, accessToken: "tok", tokenExpiresAt: new Date().toISOString() },
      { workspaceId: "ws_1", provider: "github" }
    )
    const { pool, calls } = recordingPool([githubRow({ installation_id: null, credentials })])
    const client = fakeControlPlaneClient()
    const service = new WorkspaceIntegrationService({
      pool,
      github: githubEnabled,
      linear: linearDisabled,
      controlPlaneClient: client,
      region: "eu-north-1",
    })

    const result = await service.backfillGithubRoute("ws_1")

    expect(result).toEqual({ processed: 1 })
    const update = calls.find((c) => c.text.includes("UPDATE workspace_integrations"))
    expect(update).toBeDefined()
    expect(update?.values).toContain("77")
    expect(client.registerIntegrationRoute).toHaveBeenCalledWith({
      provider: "github",
      externalId: "77",
      region: "eu-north-1",
      workspaceId: "ws_1",
    })
  })

  it("no-ops for an inactive integration", async () => {
    const { pool } = recordingPool([githubRow({ status: "inactive" })])
    const client = fakeControlPlaneClient()
    const service = new WorkspaceIntegrationService({
      pool,
      github: githubEnabled,
      linear: linearDisabled,
      controlPlaneClient: client,
      region: "eu-north-1",
    })

    const result = await service.backfillGithubRoute("ws_1")

    expect(result).toEqual({ processed: 0 })
    expect(client.registerIntegrationRoute).not.toHaveBeenCalled()
  })

  it("skips a row whose credentials cannot be decrypted", async () => {
    const { pool } = recordingPool([githubRow({ installation_id: null, credentials: { garbage: true } })])
    const client = fakeControlPlaneClient()
    const service = new WorkspaceIntegrationService({
      pool,
      github: githubEnabled,
      linear: linearDisabled,
      controlPlaneClient: client,
      region: "eu-north-1",
    })

    const result = await service.backfillGithubRoute("ws_1")

    expect(result).toEqual({ processed: 0 })
    expect(client.registerIntegrationRoute).not.toHaveBeenCalled()
  })
})
