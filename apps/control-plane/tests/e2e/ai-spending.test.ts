import { afterEach, describe, expect, test } from "bun:test"
import { Pool } from "pg"
import {
  AI_SPENDING_COVERAGE,
  type AISpendingLimits,
  type AISpendingPolicyUpdate,
  type AISpendingPolicyWire,
} from "@threahq/types"
import { TestClient, createWorkspace, loginAs } from "../client"
import { getMockRegionalBackend } from "../setup"
import { PlatformRoleRepository } from "../../src/features/backoffice"

const runId = crypto.randomUUID().slice(0, 8)

const LIMITS: AISpendingLimits = {
  agentCutoffUsd: "0.00000001",
  enrichmentCutoffUsd: "1.50",
  coreCutoffUsd: "2",
  embeddingCutoffUsd: "3",
  operatorCeilingUsd: "999999999999.99999999",
}

const UPDATE: AISpendingPolicyUpdate = {
  expectedVersion: 1,
  status: "enforced",
  coverageProfile: AI_SPENDING_COVERAGE.profile,
  limits: LIMITS,
}

function acknowledged(workspaceId: string, operator: string): AISpendingPolicyWire {
  return {
    workspaceId,
    status: "enforced",
    version: 2,
    limits: { ...LIMITS, enrichmentCutoffUsd: "1.5" },
    coverageProfile: AI_SPENDING_COVERAGE.profile,
    emergencyLatched: false,
    statusChangedAt: "2026-09-16T10:00:00.000Z",
    statusChangedBy: operator,
    updatedBy: operator,
  }
}

async function withTestDb<T>(run: (pool: Pool) => Promise<T>): Promise<T> {
  const pool = new Pool({
    connectionString:
      process.env.TEST_DATABASE_URL || "postgresql://threa:threa@localhost:5454/threa_control_plane_test",
  })
  try {
    return await run(pool)
  } finally {
    await pool.end()
  }
}

async function grantAdmin(workosUserId: string): Promise<void> {
  await withTestDb((pool) => PlatformRoleRepository.upsert(pool, workosUserId, "admin"))
}

/** The backoffice audit insert runs after the response finishes, so poll for it. */
async function auditRows(workosUserId: string, path: string) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const rows = await withTestDb(async (pool) => {
      const result = await pool.query<{ outcome: string; detail: unknown }>(
        `SELECT outcome, detail FROM auth_log
         WHERE event_type = 'cp.backoffice_request' AND workos_user_id = $1 AND detail->>'path' = $2
         ORDER BY occurred_at`,
        [workosUserId, path]
      )
      return result.rows
    })
    if (rows.length > 0) return rows
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return []
}

/** A platform admin and a workspace owned by a separate, ordinary user. */
async function setup(label: string) {
  const owner = new TestClient()
  const ownerUser = await loginAs(owner, `ai-spend-owner-${label}-${runId}@example.com`, "Workspace Owner")
  const workspace = await createWorkspace(owner, `AI spend ${label} ${runId}`)
  const admin = new TestClient()
  const adminUser = await loginAs(admin, `ai-spend-admin-${label}-${runId}@example.com`, "Platform Admin")
  await grantAdmin(adminUser.id)
  const auditPath = `/workspaces/${workspace.id}/ai-spending`
  return { owner, ownerUser, admin, adminUser, workspace, auditPath, path: `/api/backoffice${auditPath}` }
}

function aiSpendingRequests() {
  return getMockRegionalBackend().requests.filter((r) => r.url.startsWith("/internal/ai-spending/"))
}

afterEach(() => {
  getMockRegionalBackend().aiSpendingResponse = null
})

describe("Backoffice AI spending API", () => {
  test("should require a session and platform admin, and never reach the region otherwise", async () => {
    const { owner, ownerUser, path, auditPath } = await setup("authz")
    getMockRegionalBackend().reset()

    const anonymous = new TestClient()
    expect((await anonymous.get(path)).status).toBe(401)
    expect((await anonymous.request("PUT", path, UPDATE)).status).toBe(401)
    expect(await owner.get(path)).toMatchObject({ status: 403, data: { code: "NOT_PLATFORM_ADMIN" } })
    expect(await owner.request("PUT", path, UPDATE)).toMatchObject({
      status: 403,
      data: { code: "NOT_PLATFORM_ADMIN" },
    })
    expect(aiSpendingRequests()).toEqual([])
    expect(await auditRows(ownerUser.id, auditPath)).toEqual([
      { outcome: "denied", detail: { method: "GET", path: auditPath, status: 403 } },
      { outcome: "denied", detail: { method: "PUT", path: auditPath, status: 403 } },
    ])
  })

  test("should read the owning region's overview for an admin", async () => {
    const { admin, workspace, path } = await setup("read")
    const overview = {
      workspaceId: workspace.id,
      policy: null,
      currentPeriod: null,
      coverage: AI_SPENDING_COVERAGE,
    }
    getMockRegionalBackend().aiSpendingResponse = () => ({ status: 200, body: overview })
    getMockRegionalBackend().reset()

    expect(await admin.get(path)).toMatchObject({ status: 200, data: overview })
    expect(aiSpendingRequests().map(({ method, url }) => ({ method, url }))).toEqual([
      { method: "GET", url: `/internal/ai-spending/workspaces/${workspace.id}` },
    ])
  })

  test("should forward the edit with the authenticated admin as operator and return the acknowledged policy", async () => {
    const { admin, adminUser, workspace, path, auditPath } = await setup("write")
    getMockRegionalBackend().aiSpendingResponse = () => ({
      status: 200,
      body: { policy: acknowledged(workspace.id, adminUser.id) },
    })
    getMockRegionalBackend().reset()

    expect(await admin.request("PUT", path, UPDATE)).toEqual({
      status: 200,
      data: { policy: acknowledged(workspace.id, adminUser.id) },
      headers: expect.anything(),
    })
    expect(aiSpendingRequests()).toEqual([
      {
        method: "PUT",
        url: `/internal/ai-spending/workspaces/${workspace.id}`,
        body: { ...UPDATE, operatorWorkosUserId: adminUser.id },
      },
    ])
    expect(await auditRows(adminUser.id, auditPath)).toEqual([
      { outcome: "success", detail: { method: "PUT", path: auditPath, status: 200 } },
    ])
  })

  test("should reject forged identity, unprotected, and float amounts before contacting the region", async () => {
    const { admin, path } = await setup("forged")
    getMockRegionalBackend().reset()
    const bodies = [
      { ...UPDATE, operatorWorkosUserId: "workos_user_forged" },
      { ...UPDATE, workspaceId: "ws_forged" },
      { ...UPDATE, region: "elsewhere" },
      { expectedVersion: 1, status: "unprotected" },
      { ...UPDATE, limits: { ...LIMITS, coreCutoffUsd: 2 } },
      { status: "disabled" },
    ]

    const results = []
    for (const body of bodies) {
      const res = await admin.request<{ code: string }>("PUT", path, body)
      results.push({ status: res.status, code: res.data.code })
    }
    expect(results).toEqual(bodies.map(() => ({ status: 400, code: "VALIDATION_ERROR" })))
    expect(aiSpendingRequests()).toEqual([])
  })

  test("should preserve regional 409 and map regional failures to 502", async () => {
    const { admin, path } = await setup("errors")
    const answers = [
      { status: 409, body: { error: "stale", code: "STALE_SPEND_POLICY" } },
      { status: 500, body: { error: "Internal server error", code: "INTERNAL_ERROR" } },
    ]
    const results = []
    for (const answer of answers) {
      getMockRegionalBackend().aiSpendingResponse = () => answer
      const res = await admin.request<{ code: string }>("PUT", path, UPDATE)
      results.push({ status: res.status, code: res.data.code })
    }
    expect(results).toEqual([
      { status: 409, code: "STALE_SPEND_POLICY" },
      { status: 502, code: "REGION_UNAVAILABLE" },
    ])
  })

  test("should return 404 for a workspace missing from the registry", async () => {
    const { admin } = await setup("missing")
    getMockRegionalBackend().reset()
    const path = `/api/backoffice/workspaces/ws_absent_${runId}/ai-spending`

    expect(await admin.get(path)).toMatchObject({ status: 404, data: { code: "NOT_FOUND" } })
    expect(await admin.request("PUT", path, UPDATE)).toMatchObject({ status: 404, data: { code: "NOT_FOUND" } })
    expect(aiSpendingRequests()).toEqual([])
  })
})
