/**
 * Control plane → region AI spending commands through the real booted server
 * (setup.ts preload: registerRoutes, internal auth, error handler) against
 * threa_test. Responses are parsed with the shared wire schemas the control
 * plane uses, so a serialization drift fails here.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Pool } from "pg"
import {
  AI_SPENDING_COVERAGE,
  aiSpendingOverviewSchema,
  aiSpendingPolicyUpdateResultSchema,
  type AISpendingLimits,
} from "@threahq/types"
import { AISpendingService, SpendPolicyRepository } from "../../src/features/ai-usage"
import { userId, workspaceId } from "../../src/lib/id"
import { TestClient, createWorkspace, loginAs } from "../client"
import { getTestDatabaseTarget } from "../test-database"

const OPERATOR = "workos_user_spending_operator"
const LIMITS: AISpendingLimits = {
  agentCutoffUsd: "0.00000001",
  enrichmentCutoffUsd: "1.50",
  coreCutoffUsd: "2",
  embeddingCutoffUsd: "3",
  operatorCeilingUsd: "999999999999.99999999",
}
const CANONICAL_LIMITS: AISpendingLimits = { ...LIMITS, enrichmentCutoffUsd: "1.5" }

let pool: Pool
const internal = new TestClient()
const runId = crypto.randomUUID().slice(0, 8)
let seq = 0

beforeAll(() => {
  pool = new Pool({ connectionString: getTestDatabaseTarget().connectionUrl })
})

afterAll(async () => {
  await pool.end()
})

const path = (workspace: string) => `/internal/ai-spending/workspaces/${workspace}`

/** A workspace created through the real API path, which provisions an explicit `unprotected` policy. */
async function provisionedWorkspace(): Promise<string> {
  seq += 1
  const owner = new TestClient()
  await loginAs(owner, `spend-${runId}-${seq}@test.com`, "Spend Owner")
  return (await createWorkspace(owner, `Spend ${runId} ${seq}`)).id
}

/** A workspace row with no policy, as an old-code replica would leave it. */
async function workspaceWithoutPolicy(): Promise<string> {
  const id = workspaceId()
  await pool.query("INSERT INTO workspaces (id, name, slug, created_by) VALUES ($1, $2, $3, $4)", [
    id,
    "Spend legacy",
    `spend-legacy-${id.slice(-8).toLowerCase()}`,
    userId(),
  ])
  return id
}

async function getOverview(workspace: string) {
  const res = await internal.internalRequest("GET", path(workspace))
  expect(res.status).toBe(200)
  return aiSpendingOverviewSchema.parse(res.data)
}

function enforce(expectedVersion: number, limits: Partial<AISpendingLimits> = {}) {
  return {
    expectedVersion,
    status: "enforced",
    operatorWorkosUserId: OPERATOR,
    coverageProfile: AI_SPENDING_COVERAGE.profile,
    limits: { ...LIMITS, ...limits },
  }
}

async function periodIds(workspace: string): Promise<string[]> {
  const result = await pool.query<{ id: string }>("SELECT id FROM ai_spending_periods WHERE workspace_id = $1", [
    workspace,
  ])
  return result.rows.map((row) => row.id)
}

describe("internal AI spending routes", () => {
  test("should reject requests without the internal key", async () => {
    const workspace = await provisionedWorkspace()
    const anonymous = new TestClient()
    expect((await anonymous.get(path(workspace))).status).toBe(401)
    expect((await anonymous.put(path(workspace), enforce(1))).status).toBe(401)
    expect((await getOverview(workspace)).policy).toMatchObject({ status: "unprotected", version: 1 })
  })

  test("should report a missing policy as null, distinct from explicit unprotected, without creating periods", async () => {
    const missing = await workspaceWithoutPolicy()
    const unprotected = await provisionedWorkspace()

    expect(await getOverview(missing)).toEqual({
      workspaceId: missing,
      policy: null,
      currentPeriod: null,
      coverage: AI_SPENDING_COVERAGE,
    })
    const overview = await getOverview(unprotected)
    expect(overview).toEqual({
      workspaceId: unprotected,
      policy: {
        workspaceId: unprotected,
        status: "unprotected",
        version: 1,
        limits: null,
        coverageProfile: null,
        emergencyLatched: false,
        statusChangedAt: expect.any(String),
        statusChangedBy: null,
        updatedBy: null,
      },
      currentPeriod: null,
      coverage: AI_SPENDING_COVERAGE,
    })
    expect(await periodIds(unprotected)).toEqual([])
    expect(await periodIds(missing)).toEqual([])
  })

  test("should store exact decimal limits and return the acknowledged policy", async () => {
    const workspace = await provisionedWorkspace()
    const res = await internal.internalRequest("PUT", path(workspace), enforce(1))

    expect(res.status).toBe(200)
    const { policy } = aiSpendingPolicyUpdateResultSchema.parse(res.data)
    expect(policy).toEqual({
      workspaceId: workspace,
      status: "enforced",
      version: 2,
      limits: CANONICAL_LIMITS,
      coverageProfile: AI_SPENDING_COVERAGE.profile,
      emergencyLatched: false,
      statusChangedAt: expect.any(String),
      statusChangedBy: OPERATOR,
      updatedBy: OPERATOR,
    })
    expect(new Date(policy.statusChangedAt).toISOString()).toBe(policy.statusChangedAt)
    expect((await getOverview(workspace)).policy).toEqual(policy)
  })

  test("should reject a stale version with 409 and keep the first write", async () => {
    const workspace = await provisionedWorkspace()
    const first = await internal.internalRequest("PUT", path(workspace), enforce(1))
    const retry = await internal.internalRequest("PUT", path(workspace), enforce(1, { operatorCeilingUsd: "10" }))

    expect(retry).toMatchObject({ status: 409, data: { code: "STALE_SPEND_POLICY" } })
    expect((await getOverview(workspace)).policy).toEqual(aiSpendingPolicyUpdateResultSchema.parse(first.data).policy)
  })

  test("should reject invalid commands with their structured codes and leave the policy unchanged", async () => {
    const workspace = await provisionedWorkspace()
    const before = (await getOverview(workspace)).policy
    const cases: { body: unknown; status: number; code: string }[] = [
      { body: enforce(1, { coreCutoffUsd: "1e3" }), status: 400, code: "INVALID_USD" },
      { body: enforce(1, { agentCutoffUsd: "4" }), status: 400, code: "INVALID_SPEND_POLICY" },
      {
        body: { ...enforce(1), coverageProfile: "everything-v9" },
        status: 409,
        code: "SPEND_COVERAGE_NOT_ACKNOWLEDGED",
      },
      { body: { ...enforce(1), limits: { ...LIMITS, coreCutoffUsd: 2 } }, status: 400, code: "VALIDATION_ERROR" },
      {
        body: { expectedVersion: 1, status: "unprotected", operatorWorkosUserId: OPERATOR },
        status: 400,
        code: "VALIDATION_ERROR",
      },
      { body: { expectedVersion: 1, status: "disabled" }, status: 400, code: "VALIDATION_ERROR" },
      { body: { ...enforce(1), workspaceId: "ws_other" }, status: 400, code: "VALIDATION_ERROR" },
      { body: { ...enforce(1), emergencyLatched: false }, status: 400, code: "VALIDATION_ERROR" },
    ]

    const results = []
    for (const { body } of cases) {
      const res = await internal.internalRequest<{ code: string }>("PUT", path(workspace), body)
      results.push({ status: res.status, code: res.data.code })
    }
    expect(results).toEqual(cases.map(({ status, code }) => ({ status, code })))
    expect((await getOverview(workspace)).policy).toEqual(before)
  })

  test("should return 404 for a workspace this region does not have and create nothing", async () => {
    const absent = workspaceId()
    expect(await internal.internalRequest("GET", path(absent))).toMatchObject({
      status: 404,
      data: { code: "WORKSPACE_NOT_FOUND" },
    })
    expect(await internal.internalRequest("PUT", path(absent), enforce(0))).toMatchObject({
      status: 404,
      data: { code: "WORKSPACE_NOT_FOUND" },
    })
    expect(await SpendPolicyRepository.findByWorkspace(pool, absent)).toBeNull()
  })

  test("should read the current period exactly without creating another", async () => {
    const workspace = await provisionedWorkspace()
    await internal.internalRequest("PUT", path(workspace), enforce(1, { agentCutoffUsd: "1" }))
    const outcome = await new AISpendingService({ pool }).reserve({
      workspaceId: workspace,
      idempotencyKey: `period-read-${runId}`,
      sponsorUserId: "usr_sponsor",
      sessionId: null,
      operationId: "op_period_read",
      purpose: "test",
      stage: "agent",
      model: "test-model",
      providerRoute: "test-route",
      provider: "openrouter",
      functionId: "test",
      maxCostUsd: "0.12345678",
    })
    if (!outcome.allowed) throw new Error(`reserve denied: ${outcome.reason}`)

    const overview = await getOverview(workspace)
    await getOverview(workspace)

    expect(overview.currentPeriod).toEqual({
      id: outcome.period.id,
      workspaceId: workspace,
      startsAt: outcome.period.startsAt.toISOString(),
      endsAt: outcome.period.endsAt.toISOString(),
      timezone: outcome.period.timezone,
      settledUsd: "0",
      committedUsd: "0.12345678",
    })
    expect(await periodIds(workspace)).toEqual([outcome.period.id])
  })

  test("should keep limits when disabling and never clear an emergency latch through an edit", async () => {
    const workspace = await provisionedWorkspace()
    await internal.internalRequest("PUT", path(workspace), enforce(1))
    const disabled = await internal.internalRequest("PUT", path(workspace), {
      expectedVersion: 2,
      status: "disabled",
      operatorWorkosUserId: OPERATOR,
    })
    expect(aiSpendingPolicyUpdateResultSchema.parse(disabled.data).policy).toMatchObject({
      status: "disabled",
      version: 3,
      limits: CANONICAL_LIMITS,
      coverageProfile: AI_SPENDING_COVERAGE.profile,
    })

    await SpendPolicyRepository.latchEmergency(pool, workspace)
    const latchedVersion = (await getOverview(workspace)).policy!.version
    const reenforced = await internal.internalRequest("PUT", path(workspace), enforce(latchedVersion))
    expect(aiSpendingPolicyUpdateResultSchema.parse(reenforced.data).policy).toMatchObject({
      status: "enforced",
      version: latchedVersion + 1,
      emergencyLatched: true,
    })
  })
})
