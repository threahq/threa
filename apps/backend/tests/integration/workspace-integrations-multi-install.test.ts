import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { WorkspaceIntegrationProviders } from "@threa/types"
import { setupTestDatabase, withTestTransaction } from "./setup"
import {
  WorkspaceIntegrationRepository,
  type UpsertWorkspaceIntegrationParams,
} from "../../src/features/workspace-integrations/repository"
import { workspaceIntegrationId } from "../../src/lib/id"

/**
 * Real-Postgres coverage for the multi-install schema (two partial unique
 * indexes) and the row-scoped `update`. The headline risk is a write matching
 * more than one of a workspace's N GitHub installations; these tests exercise
 * the ON CONFLICT targets and `installation_id IS NOT DISTINCT FROM $scope`
 * against the actual indexes, not by eyeballing SQL.
 */
const WS = "ws_multi_install"

function githubUpsert(overrides: Partial<UpsertWorkspaceIntegrationParams> = {}): UpsertWorkspaceIntegrationParams {
  return {
    id: workspaceIntegrationId(),
    workspaceId: WS,
    provider: WorkspaceIntegrationProviders.GITHUB,
    status: "active",
    credentials: {},
    metadata: {},
    installedBy: "user_1",
    installationId: null,
    ...overrides,
  }
}

describe("workspace_integrations multi-install", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  test("two GitHub installs coexist for one workspace", async () => {
    await withTestTransaction(pool, async (client) => {
      await WorkspaceIntegrationRepository.upsert(client, githubUpsert({ installationId: "100" }))
      await WorkspaceIntegrationRepository.upsert(client, githubUpsert({ installationId: "200" }))

      const installs = await WorkspaceIntegrationRepository.listByWorkspaceAndProvider(
        client,
        WS,
        WorkspaceIntegrationProviders.GITHUB
      )
      expect(installs.map((i) => i.installationId).sort()).toEqual(["100", "200"])
    })
  })

  test("re-upsert of the same (workspace, provider, installation) updates in place (no second row)", async () => {
    await withTestTransaction(pool, async (client) => {
      const first = await WorkspaceIntegrationRepository.upsert(
        client,
        githubUpsert({ installationId: "300", metadata: { organizationName: "before" } })
      )
      const second = await WorkspaceIntegrationRepository.upsert(
        client,
        githubUpsert({ installationId: "300", metadata: { organizationName: "after" } })
      )

      const installs = await WorkspaceIntegrationRepository.listByWorkspaceAndProvider(
        client,
        WS,
        WorkspaceIntegrationProviders.GITHUB
      )
      expect(installs).toHaveLength(1)
      // Conflict keeps the original row id and bumps the version.
      expect(second.id).toBe(first.id)
      expect(second.version).toBe(first.version + 1)
      expect(second.metadata.organizationName).toBe("after")
    })
  })

  test("a second NULL-installation row for the same (workspace, provider) is rejected", async () => {
    await withTestTransaction(pool, async (client) => {
      const insertNull = (id: string) =>
        client.query(
          `INSERT INTO workspace_integrations
             (id, workspace_id, provider, status, credentials, metadata, installed_by, installation_id)
           VALUES ($1, $2, 'linear', 'active', '{}'::jsonb, '{}'::jsonb, 'user_1', NULL)`,
          [id, WS]
        )

      await insertNull(workspaceIntegrationId())
      await expect(insertNull(workspaceIntegrationId())).rejects.toThrow(/duplicate key|unique/i)
    })
  })

  test("scoped update touches EXACTLY ONE of two installs", async () => {
    await withTestTransaction(pool, async (client) => {
      const a = await WorkspaceIntegrationRepository.upsert(client, githubUpsert({ installationId: "100" }))
      const b = await WorkspaceIntegrationRepository.upsert(client, githubUpsert({ installationId: "200" }))

      const updated = await WorkspaceIntegrationRepository.update(
        client,
        WS,
        WorkspaceIntegrationProviders.GITHUB,
        "100",
        { status: "inactive" }
      )
      expect(updated?.id).toBe(a.id)

      const afterA = await WorkspaceIntegrationRepository.findByWorkspaceAndId(client, WS, a.id)
      const afterB = await WorkspaceIntegrationRepository.findByWorkspaceAndId(client, WS, b.id)
      expect(afterA?.status).toBe("inactive")
      expect(afterB?.status).toBe("active")
    })
  })

  test("scoped update with scope NULL touches only the NULL-installation row when an id row coexists", async () => {
    await withTestTransaction(pool, async (client) => {
      const legacy = await WorkspaceIntegrationRepository.upsert(client, githubUpsert({ installationId: null }))
      const withId = await WorkspaceIntegrationRepository.upsert(client, githubUpsert({ installationId: "100" }))

      const updated = await WorkspaceIntegrationRepository.update(
        client,
        WS,
        WorkspaceIntegrationProviders.GITHUB,
        null,
        { metadata: { organizationName: "legacy-touched" } }
      )
      expect(updated?.id).toBe(legacy.id)

      const afterLegacy = await WorkspaceIntegrationRepository.findByWorkspaceAndId(client, WS, legacy.id)
      const afterWithId = await WorkspaceIntegrationRepository.findByWorkspaceAndId(client, WS, withId.id)
      expect(afterLegacy?.metadata.organizationName).toBe("legacy-touched")
      expect(afterWithId?.metadata.organizationName).toBeUndefined()
    })
  })

  // Linear stores its org id in installation_id, so it lands on the multi-install
  // index (#1), not the NULL index. Its single-row guarantee is upheld by the
  // id-keyed upsert: reconnecting the same row to a different org must REPLACE it
  // (rewrite installation_id on the reused ULID), never insert a second row or
  // collide on the primary key.
  test("Linear org switch replaces the single row via id-keyed upsert (no PK collision, no second row)", async () => {
    await withTestTransaction(pool, async (client) => {
      const linearRow = (id: string, installationId: string): UpsertWorkspaceIntegrationParams => ({
        id,
        workspaceId: WS,
        provider: WorkspaceIntegrationProviders.LINEAR,
        status: "active",
        credentials: {},
        metadata: { organizationId: installationId },
        installedBy: "user_1",
        installationId,
      })

      const orgA = await WorkspaceIntegrationRepository.upsert(
        client,
        linearRow(workspaceIntegrationId(), "orgA"),
        "id"
      )
      // Reconnect the SAME row (reused ULID) to a different org — the failure mode
      // was an installation-keyed arbiter missing on the org switch and raising a
      // duplicate-key error on the reused id.
      const switched = await WorkspaceIntegrationRepository.upsert(client, linearRow(orgA.id, "orgB"), "id")

      const rows = await WorkspaceIntegrationRepository.listByWorkspaceAndProvider(
        client,
        WS,
        WorkspaceIntegrationProviders.LINEAR
      )
      expect(rows).toHaveLength(1)
      expect(switched.id).toBe(orgA.id)
      expect(rows[0].installationId).toBe("orgB")
    })
  })

  // Connecting a wrong org while an active Linear row exists is the same
  // reuse-existing-row path (completeLinearInstallation reuses the found row's id):
  // it must replace, not add.
  test("Linear connect-different-org while active replaces in place", async () => {
    await withTestTransaction(pool, async (client) => {
      const active = await WorkspaceIntegrationRepository.upsert(
        client,
        {
          id: workspaceIntegrationId(),
          workspaceId: WS,
          provider: WorkspaceIntegrationProviders.LINEAR,
          status: "active",
          credentials: {},
          metadata: { organizationId: "orgA" },
          installedBy: "user_1",
          installationId: "orgA",
        },
        "id"
      )

      const replaced = await WorkspaceIntegrationRepository.upsert(
        client,
        {
          id: active.id,
          workspaceId: WS,
          provider: WorkspaceIntegrationProviders.LINEAR,
          status: "active",
          credentials: {},
          metadata: { organizationId: "orgB" },
          installedBy: "user_1",
          installationId: "orgB",
        },
        "id"
      )

      const rows = await WorkspaceIntegrationRepository.listByWorkspaceAndProvider(
        client,
        WS,
        WorkspaceIntegrationProviders.LINEAR
      )
      expect(rows).toHaveLength(1)
      expect(replaced.installationId).toBe("orgB")
    })
  })
})
