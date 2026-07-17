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

  it("unregisters the CP route BEFORE clearing the row", async () => {
    // Mirrors deactivateInstallation's ordering: the update wipes credentials,
    // which for a pre-backfill row (null plaintext column) is the only copy of
    // the installation id. If unregister throws after the clear, a retry can't
    // re-resolve the id and the CP route is stranded forever.
    const events: string[] = []
    const pool = {
      query: async (query: unknown) => {
        const text = typeof query === "string" ? query : ((query as { text?: string })?.text ?? "")
        if (text.includes("UPDATE workspace_integrations")) events.push("update")
        return { rows: [githubRow()], rowCount: 1 }
      },
    } as unknown as Pool
    const client = {
      registerIntegrationRoute: mock(async () => {}),
      unregisterIntegrationRoute: mock(async () => {
        events.push("unregister")
      }),
    } as unknown as ControlPlaneClient
    const service = new WorkspaceIntegrationService({
      pool,
      github: githubEnabled,
      linear: linearDisabled,
      controlPlaneClient: client,
      region: "eu-north-1",
    })

    await service.disconnectGithubIntegration("ws_1")

    expect(events).toEqual(["unregister", "update"])
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

  it("undoes the route when a disconnect interleaves between the guarded update and register", async () => {
    // The guarded UPDATE matches (status still active at that instant), the route
    // is registered, but a disconnect then flips status to 'inactive' and deletes
    // the CP route. The post-register re-read must catch the loss and unregister the
    // route this backfill just resurrected — the disconnect wins.
    let selectCount = 0
    const calls: QueryCall[] = []
    const pool = {
      query: async (query: unknown, values: unknown[] = []) => {
        const text = typeof query === "string" ? query : ((query as { text?: string })?.text ?? "")
        calls.push({ text, values })
        if (text.includes("UPDATE workspace_integrations")) {
          return { rows: [githubRow({ installation_id: "42" })], rowCount: 1 }
        }
        // First SELECT: active (drives the update). Second SELECT (post-register
        // re-check): the disconnect has landed → inactive.
        selectCount += 1
        const status = selectCount === 1 ? "active" : "inactive"
        return { rows: [githubRow({ installation_id: "42", status })], rowCount: 1 }
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
    expect(client.registerIntegrationRoute).toHaveBeenCalledWith({
      provider: "github",
      externalId: "42",
      region: "eu-north-1",
      workspaceId: "ws_1",
    })
    expect(client.unregisterIntegrationRoute).toHaveBeenCalledWith({
      provider: "github",
      externalId: "42",
      workspaceId: "ws_1",
    })
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
      controlPlaneClient: null,
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
  it("marks each workspace's integration inactive and unregisters its CP route", async () => {
    const { pool, calls } = recordingPool([githubRow({ workspace_id: "ws_1" })])
    const client = fakeControlPlaneClient()
    const service = new WorkspaceIntegrationService({
      pool,
      github: githubEnabled,
      linear: linearDisabled,
      controlPlaneClient: client,
      region: "eu-north-1",
    })

    const result = await service.deactivateInstallation("42")

    expect(result).toEqual({ deactivatedWorkspaceIds: ["ws_1"] })
    const update = calls.find((c) => c.text.includes("UPDATE workspace_integrations"))
    expect(update?.values).toContain("inactive")
    // Guarded on active so a concurrent reconnect isn't clobbered.
    expect(update?.values).toContain("active")
    expect(client.unregisterIntegrationRoute).toHaveBeenCalledWith({
      provider: "github",
      externalId: "42",
      workspaceId: "ws_1",
    })
  })

  it("unregisters the CP route BEFORE flipping status inactive", async () => {
    // Load-bearing ordering: listActiveByInstallationId gates on status='active',
    // so if the flip ran first and the CP unregister then threw, a retry would
    // re-list [] and never re-attempt the DELETE — stranding a CP route that fans
    // webhooks to a dead region. Pin the order so a reorder can't regress silently.
    const events: string[] = []
    const pool = {
      query: async (query: unknown, values: unknown[] = []) => {
        const text = typeof query === "string" ? query : ((query as { text?: string })?.text ?? "")
        if (text.includes("UPDATE workspace_integrations")) events.push("update")
        return { rows: [githubRow({ workspace_id: "ws_1" })], rowCount: 1 }
      },
    } as unknown as Pool
    const client = {
      registerIntegrationRoute: mock(async () => {}),
      unregisterIntegrationRoute: mock(async () => {
        events.push("unregister")
      }),
    } as unknown as ControlPlaneClient & {
      registerIntegrationRoute: ReturnType<typeof mock>
      unregisterIntegrationRoute: ReturnType<typeof mock>
    }
    const service = new WorkspaceIntegrationService({
      pool,
      github: githubEnabled,
      linear: linearDisabled,
      controlPlaneClient: client,
      region: "eu-north-1",
    })

    await service.deactivateInstallation("42")

    expect(events).toEqual(["unregister", "update"])
  })

  it("no-ops with no active integrations", async () => {
    const { pool } = recordingPool([])
    const client = fakeControlPlaneClient()
    const service = new WorkspaceIntegrationService({
      pool,
      github: githubEnabled,
      linear: linearDisabled,
      controlPlaneClient: client,
      region: "eu-north-1",
    })

    const result = await service.deactivateInstallation("42")

    expect(result).toEqual({ deactivatedWorkspaceIds: [] })
    expect(client.unregisterIntegrationRoute).not.toHaveBeenCalled()
  })
})
