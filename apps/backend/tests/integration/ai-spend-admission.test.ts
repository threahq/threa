/**
 * The AI spending ledger against a real schema (INV-68): explicit enrollment
 * status, admission under the workspace anchor lock, single-winner
 * dispatch/release, exact idempotent settlement, immutable periods across
 * timezone edits, and workspace isolation.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import {
  AI_SPENDING_COVERAGE,
  type AISpendingAttemptRequest,
  type AISpendingLimits,
  type AISpendingPolicy,
  type AISpendingPolicyInput,
  type AISpendingReceipt,
} from "@threahq/types"
import {
  AISpendingService,
  InvalidSpendPolicyError,
  MalformedSpendPolicyError,
  SpendAttemptConflictError,
  SpendAttemptStateError,
  SpendCoverageNotAcknowledgedError,
  SpendPolicyRepository,
  SpendReceiptConflictError,
  StaleSpendPolicyError,
} from "../../src/features/ai-usage"
import { WorkspaceSettingsRepository } from "../../src/features/workspace-settings"
import { userId, workspaceId } from "../../src/lib/id"
import { setupIsolatedTestDatabase } from "./setup"

let pool: Pool
let cleanup: () => Promise<void>
let now = new Date("2026-09-16T10:00:00Z")
let service: AISpendingService
let keyCounter = 0

const OPERATOR = "workos_user_operator"

beforeAll(async () => {
  const db = await setupIsolatedTestDatabase("ai-spend-admission")
  pool = db.pool
  cleanup = db.cleanup
  service = new AISpendingService({ pool, now: () => now })
})

afterAll(async () => {
  await cleanup()
})

/** A workspace with no policy row, as an old-code replica would leave it. */
async function seedWorkspace(): Promise<string> {
  const id = workspaceId()
  await pool.query("INSERT INTO workspaces (id, name, slug, created_by) VALUES ($1, $2, $3, $4)", [
    id,
    "Spend",
    `spend-${id.slice(-8).toLowerCase()}`,
    userId(),
  ])
  return id
}

async function seedProvisionedWorkspace(): Promise<string> {
  const workspace = await seedWorkspace()
  await SpendPolicyRepository.insertUnprotected(pool, [workspace])
  return workspace
}

const LIMITS: AISpendingLimits = {
  agentCutoffUsd: "1",
  enrichmentCutoffUsd: "2",
  coreCutoffUsd: "3",
  embeddingCutoffUsd: "4",
  operatorCeilingUsd: "5",
}

const WIDE_CUTOFFS = { agentCutoffUsd: "5", enrichmentCutoffUsd: "5", coreCutoffUsd: "5", embeddingCutoffUsd: "5" }

function enforceInput(
  workspace: string,
  overrides: Partial<AISpendingLimits> & { expectedVersion?: number; coverageProfile?: string; operator?: string } = {}
): AISpendingPolicyInput {
  const {
    expectedVersion = 1,
    coverageProfile = AI_SPENDING_COVERAGE.profile,
    operator = OPERATOR,
    ...limits
  } = overrides
  return {
    workspaceId: workspace,
    expectedVersion,
    operatorWorkosUserId: operator,
    status: "enforced",
    coverageProfile,
    limits: { ...LIMITS, ...limits },
  }
}

function disableInput(workspace: string, expectedVersion: number, operator = OPERATOR): AISpendingPolicyInput {
  return { workspaceId: workspace, expectedVersion, operatorWorkosUserId: operator, status: "disabled" }
}

async function versionOf(workspace: string): Promise<number> {
  const policy = await service.getPolicy(workspace)
  if (!policy) throw new Error(`no policy for ${workspace}`)
  return policy.version
}

async function seedEnforcedWorkspace(limits: Partial<AISpendingLimits> = {}): Promise<string> {
  const workspace = await seedProvisionedWorkspace()
  await service.setPolicy(enforceInput(workspace, limits))
  return workspace
}

function request(workspace: string, overrides: Partial<AISpendingAttemptRequest> = {}): AISpendingAttemptRequest {
  keyCounter += 1
  return {
    workspaceId: workspace,
    idempotencyKey: `key-${keyCounter}`,
    sponsorUserId: "usr_sponsor",
    // Ledger-only: no session workflow here, so no execution to fence.
    sessionId: null,
    operationId: "op_root",
    purpose: "assistant_turn",
    stage: "agent",
    model: "openrouter:openai/gpt-5.6-luna",
    providerRoute: "openrouter",
    provider: "openrouter",
    functionId: "agent-loop",
    maxCostUsd: "0.1",
    ...overrides,
  }
}

async function reserved(workspace: string, overrides: Partial<AISpendingAttemptRequest> = {}) {
  const outcome = await service.reserve(request(workspace, overrides))
  if (!outcome.allowed) throw new Error(`expected admission, got ${outcome.reason}`)
  return outcome.attempt
}

async function dispatched(workspace: string, overrides: Partial<AISpendingAttemptRequest> = {}) {
  const attempt = await reserved(workspace, overrides)
  const outcome = await service.dispatch(workspace, attempt.id, null)
  if (!outcome.dispatched) throw new Error(`expected dispatch, got ${outcome.reason}`)
  return outcome.attempt
}

async function totals(workspace: string) {
  const periods = await service.listPeriods(workspace)
  return periods.map((p) => ({ settledUsd: p.settledUsd, committedUsd: p.committedUsd }))
}

const receipt: AISpendingReceipt = { providerRequestId: "req_1", usage: { inputTokens: 120, outputTokens: 40 } }

describe("enrollment status", () => {
  test("rejects a policy change without a workspace anchor instead of permitting unlocked spending", async () => {
    const missing = workspaceId()
    await expect(service.setPolicy(enforceInput(missing, { expectedVersion: 0 }))).rejects.toThrow(
      /Spending workspace .* does not exist/
    )
    expect(await service.getPolicy(missing)).toBeNull()
    expect(await service.listPeriods(missing)).toEqual([])
  })

  test("a workspace without a policy row is denied and opens no period", async () => {
    const workspace = await seedWorkspace()
    expect(await service.reserve(request(workspace))).toEqual({ allowed: false, reason: "NOT_PROVISIONED" })
    expect(await service.dispatch(workspace, "ai_attempt_missing", null)).toEqual({
      dispatched: false,
      reason: "NOT_PROVISIONED",
    })
    expect(await service.listPeriods(workspace)).toEqual([])
  })

  test("an explicitly unprotected workspace has no limits, is never metered-and-allowed, and opens no period", async () => {
    const workspace = await seedProvisionedWorkspace()
    const policy = await service.getPolicy(workspace)
    expect(policy).toEqual({
      workspaceId: workspace,
      version: 1,
      status: "unprotected",
      limits: null,
      coverageProfile: null,
      emergencyLatched: false,
      statusChangedAt: expect.any(Date),
      statusChangedBy: null,
      updatedBy: null,
    })
    expect(await service.reserve(request(workspace))).toEqual({ allowed: false, reason: "NOT_ENFORCED" })
    expect(await service.dispatch(workspace, "ai_attempt_missing", null)).toEqual({
      dispatched: false,
      reason: "NOT_ENFORCED",
    })
    expect(await service.listPeriods(workspace)).toEqual([])
  })

  test("provisioning never changes an existing policy", async () => {
    const workspace = await seedEnforcedWorkspace()
    const before = await service.getPolicy(workspace)
    expect(await SpendPolicyRepository.insertUnprotected(pool, [workspace])).toBe(0)
    expect(await service.getPolicy(workspace)).toEqual(before)
  })

  test("an operator edit can never set a workspace back to unprotected", async () => {
    const provisioned = await seedProvisionedWorkspace()
    const enforced = await seedEnforcedWorkspace()
    const disabled = await seedProvisionedWorkspace()
    await service.setPolicy(disableInput(disabled, 1))
    for (const workspace of [provisioned, enforced, disabled]) {
      const before = await service.getPolicy(workspace)
      const unprotect = { ...disableInput(workspace, before!.version), status: "unprotected" }
      await expect(service.setPolicy(unprotect as unknown as AISpendingPolicyInput)).rejects.toBeInstanceOf(
        InvalidSpendPolicyError
      )
      expect(await service.getPolicy(workspace)).toEqual(before)
    }
  })

  test("enforcing requires acknowledging exactly the current coverage profile", async () => {
    const workspace = await seedProvisionedWorkspace()
    const before = await service.getPolicy(workspace)
    for (const coverageProfile of [undefined, "", "assistant-text-v2", "all"]) {
      const input = { ...enforceInput(workspace), coverageProfile }
      await expect(service.setPolicy(input as AISpendingPolicyInput)).rejects.toBeInstanceOf(
        SpendCoverageNotAcknowledgedError
      )
    }
    expect(await service.getPolicy(workspace)).toEqual(before)
    expect(await service.reserve(request(workspace))).toEqual({ allowed: false, reason: "NOT_ENFORCED" })
  })

  test("enforcing requires all five exact, ordered limits and an operator identity", async () => {
    const workspace = await seedProvisionedWorkspace()
    const before = await service.getPolicy(workspace)
    const { operatorCeilingUsd: _omitted, ...fourLimits } = LIMITS
    const invalid: unknown[] = [
      { ...enforceInput(workspace), limits: undefined },
      { ...enforceInput(workspace), limits: fourLimits },
      { ...enforceInput(workspace), limits: { ...LIMITS, coreCutoffUsd: null } },
      enforceInput(workspace, { coreCutoffUsd: "1.5" }),
      enforceInput(workspace, { operatorCeilingUsd: "3.99999999" }),
      enforceInput(workspace, { operator: " " }),
    ]
    for (const input of invalid) {
      await expect(service.setPolicy(input as AISpendingPolicyInput)).rejects.toBeInstanceOf(InvalidSpendPolicyError)
    }
    await expect(service.setPolicy(enforceInput(workspace, { agentCutoffUsd: "0.1e1" }))).rejects.toThrow(
      /Invalid USD amount/
    )
    expect(await service.getPolicy(workspace)).toEqual(before)
  })

  test("status metadata records the operator and moves only when the status changes", async () => {
    const workspace = await seedProvisionedWorkspace()
    const provisioned = await service.getPolicy(workspace)
    await Bun.sleep(5)
    const enforced = await service.setPolicy(enforceInput(workspace, { agentCutoffUsd: "1.50", operator: "op_a" }))
    expect(enforced).toEqual({
      workspaceId: workspace,
      version: 2,
      status: "enforced",
      limits: { ...LIMITS, agentCutoffUsd: "1.5" },
      coverageProfile: AI_SPENDING_COVERAGE.profile,
      emergencyLatched: false,
      statusChangedAt: expect.any(Date),
      statusChangedBy: "op_a",
      updatedBy: "op_a",
    })
    expect(enforced.statusChangedAt.getTime()).toBeGreaterThan(provisioned!.statusChangedAt.getTime())

    await Bun.sleep(5)
    const edited = await service.setPolicy(
      enforceInput(workspace, { expectedVersion: 2, agentCutoffUsd: "0", operator: "op_b" })
    )
    expect(edited).toEqual({
      ...enforced,
      version: 3,
      limits: { ...LIMITS, agentCutoffUsd: "0" },
      updatedBy: "op_b",
    })

    await Bun.sleep(5)
    const disabled = await service.setPolicy(disableInput(workspace, 3, "op_b"))
    expect(disabled).toEqual({
      ...edited,
      version: 4,
      status: "disabled",
      statusChangedAt: expect.any(Date),
      statusChangedBy: "op_b",
    })
    expect(disabled.statusChangedAt.getTime()).toBeGreaterThan(edited.statusChangedAt.getTime())
    expect(await service.reserve(request(workspace))).toEqual({ allowed: false, reason: "DISABLED" })
  })

  test("a stale writer is rejected loudly and concurrent edits have exactly one winner", async () => {
    const workspace = await seedProvisionedWorkspace()
    await expect(service.setPolicy(enforceInput(workspace, { expectedVersion: 2 }))).rejects.toBeInstanceOf(
      StaleSpendPolicyError
    )
    await expect(service.setPolicy(enforceInput(workspace, { expectedVersion: 0 }))).rejects.toBeInstanceOf(
      StaleSpendPolicyError
    )
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, index) =>
        service.setPolicy(
          index % 2 === 0
            ? disableInput(workspace, 1, `op_${index}`)
            : enforceInput(workspace, { agentCutoffUsd: `0.${index}`, operator: `op_${index}` })
        )
      )
    )
    const fulfilled = results.filter((r) => r.status === "fulfilled")
    expect(fulfilled).toHaveLength(1)
    for (const rejected of results.filter((r) => r.status === "rejected")) {
      expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(StaleSpendPolicyError)
    }
    expect(await service.getPolicy(workspace)).toEqual((fulfilled[0] as PromiseFulfilledResult<AISpendingPolicy>).value)
  })

  test("concurrent operator creation of a never-provisioned policy produces exactly one policy", async () => {
    const workspace = await seedWorkspace()
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, index) =>
        service.setPolicy(enforceInput(workspace, { expectedVersion: 0, agentCutoffUsd: `0.${index + 1}` }))
      )
    )
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    for (const rejected of results.filter((r) => r.status === "rejected")) {
      expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(StaleSpendPolicyError)
    }
    expect(await service.getPolicy(workspace)).toMatchObject({ version: 1, status: "enforced", updatedBy: OPERATOR })
  })

  test("malformed persisted policies fail closed instead of admitting", async () => {
    const corruptions = [
      "UPDATE ai_spending_policies SET status = 'enforced' WHERE workspace_id = $1",
      "UPDATE ai_spending_policies SET coverage_profile = NULL WHERE workspace_id = $1",
      "UPDATE ai_spending_policies SET coverage_profile = 'assistant-text-v0' WHERE workspace_id = $1",
      "UPDATE ai_spending_policies SET operator_ceiling_usd = NULL WHERE workspace_id = $1",
      "UPDATE ai_spending_policies SET agent_cutoff_usd = operator_ceiling_usd + 1 WHERE workspace_id = $1",
      "UPDATE ai_spending_policies SET status = 'paused' WHERE workspace_id = $1",
    ]
    for (const corruption of corruptions) {
      const workspace = corruption.includes("'enforced'")
        ? await seedProvisionedWorkspace()
        : await seedEnforcedWorkspace()
      const attempt = corruption.includes("'enforced'") ? null : await reserved(workspace)
      await pool.query(corruption, [workspace])
      await expect(service.reserve(request(workspace))).rejects.toBeInstanceOf(MalformedSpendPolicyError)
      if (attempt) {
        await expect(service.dispatch(workspace, attempt.id, null)).rejects.toBeInstanceOf(MalformedSpendPolicyError)
        expect((await service.getAttempt(workspace, attempt.id))?.state).toBe("reserved")
      } else {
        expect(await service.listPeriods(workspace)).toEqual([])
      }
    }
  })
})

describe("admission", () => {
  test("zero thresholds admit only zero-cost attempts", async () => {
    const workspace = await seedEnforcedWorkspace({
      agentCutoffUsd: "0",
      enrichmentCutoffUsd: "0",
      coreCutoffUsd: "0",
      embeddingCutoffUsd: "0",
      operatorCeilingUsd: "0",
    })
    const zero = await service.reserve(request(workspace, { maxCostUsd: "0" }))
    expect(zero.allowed).toBe(true)
    expect(await service.reserve(request(workspace, { maxCostUsd: "0.00000001", stage: "embedding" }))).toEqual({
      allowed: false,
      reason: "LIMIT_EXCEEDED",
      stage: "embedding",
      cutoffUsd: "0",
      settledUsd: "0",
      committedUsd: "0",
    })
  })

  test("settled spend plus every outstanding commitment plus the new bound must fit the stage cutoff exactly", async () => {
    const workspace = await seedEnforcedWorkspace({ agentCutoffUsd: "1", enrichmentCutoffUsd: "1.2" })
    const settledAttempt = await dispatched(workspace, { maxCostUsd: "0.6" })
    await service.settle({ workspaceId: workspace, attemptId: settledAttempt.id, actualCostUsd: "0.3", receipt })
    await reserved(workspace, { maxCostUsd: "0.2" })
    const unknownAttempt = await dispatched(workspace, { maxCostUsd: "0.2" })
    await service.markUnknown(workspace, unknownAttempt.id)
    expect(await totals(workspace)).toEqual([{ settledUsd: "0.3", committedUsd: "0.4" }])

    const overByOne = await service.reserve(request(workspace, { maxCostUsd: "0.30000001" }))
    expect(overByOne).toEqual({
      allowed: false,
      reason: "LIMIT_EXCEEDED",
      stage: "agent",
      cutoffUsd: "1",
      settledUsd: "0.3",
      committedUsd: "0.4",
    })
    const exact = await service.reserve(request(workspace, { maxCostUsd: "0.3" }))
    expect(exact.allowed && exact.period.committedUsd).toBe("0.7")
    expect(await service.reserve(request(workspace, { maxCostUsd: "0.00000001" }))).toMatchObject({
      allowed: false,
      reason: "LIMIT_EXCEEDED",
      stage: "agent",
    })
    const laterStage = await service.reserve(request(workspace, { maxCostUsd: "0.2", stage: "enrichment" }))
    expect(laterStage.allowed).toBe(true)
    expect(await totals(workspace)).toEqual([{ settledUsd: "0.3", committedUsd: "0.9" }])
  })

  test("concurrent near-cap reservations admit exactly what fits", async () => {
    const workspace = await seedEnforcedWorkspace({ agentCutoffUsd: "1" })
    const settledAttempt = await dispatched(workspace, { maxCostUsd: "0.3" })
    await service.settle({ workspaceId: workspace, attemptId: settledAttempt.id, actualCostUsd: "0.3", receipt })
    await reserved(workspace, { maxCostUsd: "0.2" })

    const outcomes = await Promise.all(
      Array.from({ length: 12 }, () => service.reserve(request(workspace, { maxCostUsd: "0.1" })))
    )
    expect(outcomes.filter((o) => o.allowed)).toHaveLength(5)
    expect(outcomes.filter((o) => !o.allowed).map((o) => o.reason)).toEqual(Array(7).fill("LIMIT_EXCEEDED"))
    expect(await totals(workspace)).toEqual([{ settledUsd: "0.3", committedUsd: "0.7" }])
    const rows = await pool.query(
      "SELECT state, COUNT(*)::int AS n FROM ai_spending_attempts WHERE workspace_id = $1 GROUP BY state ORDER BY state",
      [workspace]
    )
    expect(rows.rows).toEqual([
      { state: "reserved", n: 6 },
      { state: "settled", n: 1 },
    ])
  })

  test("a repeated idempotency key returns the same attempt once; a changed identity is a conflict", async () => {
    const workspace = await seedEnforcedWorkspace()
    const first = request(workspace, { maxCostUsd: "0.25" })
    const [a, b] = await Promise.all([service.reserve(first), service.reserve(first)])
    expect(a.allowed && b.allowed && a.attempt.id).toBe(b.allowed ? b.attempt.id : "")
    const again = await service.reserve(first)
    expect(again.allowed && again.attempt).toEqual(a.allowed && a.attempt)
    expect([a, b, again].map((o) => o.allowed && o.created).sort()).toEqual([false, false, true])
    expect(await totals(workspace)).toEqual([{ settledUsd: "0", committedUsd: "0.25" }])

    for (const drift of [
      { maxCostUsd: "0.26" },
      { model: "openrouter:other/model" },
      { sponsorUserId: "usr_other" },
      { sessionId: "session_other" },
      { operationId: "op_other" },
      { stage: "core" as const },
    ]) {
      await expect(service.reserve({ ...first, ...drift })).rejects.toBeInstanceOf(SpendAttemptConflictError)
    }
    expect(await totals(workspace)).toEqual([{ settledUsd: "0", committedUsd: "0.25" }])
  })

  test("a disabled policy denies admission and dispatch of an already reserved attempt", async () => {
    const workspace = await seedEnforcedWorkspace()
    const attempt = await reserved(workspace)
    await service.setPolicy(disableInput(workspace, await versionOf(workspace)))
    expect(await service.reserve(request(workspace))).toEqual({ allowed: false, reason: "DISABLED" })
    expect(await service.dispatch(workspace, attempt.id, null)).toEqual({ dispatched: false, reason: "DISABLED" })
    expect((await service.getAttempt(workspace, attempt.id))?.state).toBe("reserved")
    expect(await service.release(workspace, attempt.id, null)).toBe(true)
    expect(await totals(workspace)).toEqual([{ settledUsd: "0", committedUsd: "0" }])
  })
})

describe("dispatch, release and unknown", () => {
  test("concurrent dispatch has one winner; duplicates and released attempts cannot dispatch", async () => {
    const workspace = await seedEnforcedWorkspace()
    const attempt = await reserved(workspace)
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => service.dispatch(workspace, attempt.id, null)))
    expect(outcomes.filter((o) => o.dispatched)).toHaveLength(1)
    expect(outcomes.filter((o) => !o.dispatched)).toEqual(
      Array(5).fill({ dispatched: false, reason: "NOT_RESERVED", state: "dispatched" })
    )
    expect(await service.dispatch(workspace, attempt.id, null)).toEqual({
      dispatched: false,
      reason: "NOT_RESERVED",
      state: "dispatched",
    })

    const releasedAttempt = await reserved(workspace)
    expect(await service.release(workspace, releasedAttempt.id, null)).toBe(true)
    expect(await service.release(workspace, releasedAttempt.id, null)).toBe(false)
    expect(await service.dispatch(workspace, releasedAttempt.id, null)).toEqual({
      dispatched: false,
      reason: "NOT_RESERVED",
      state: "released",
    })
    expect((await service.getAttempt(workspace, releasedAttempt.id))?.state).toBe("released")
    expect(await totals(workspace)).toEqual([{ settledUsd: "0", committedUsd: "0.1" }])
  })

  test("release racing dispatch yields exactly one outcome and consistent commitments", async () => {
    const workspace = await seedEnforcedWorkspace(WIDE_CUTOFFS)
    let stillCommitted = 0n
    for (let round = 0; round < 8; round++) {
      const attempt = await reserved(workspace)
      const [released, dispatch] = await Promise.all([
        service.release(workspace, attempt.id, null),
        service.dispatch(workspace, attempt.id, null),
      ])
      expect(released).not.toBe(dispatch.dispatched)
      const row = await service.getAttempt(workspace, attempt.id)
      expect(row?.state).toBe(released ? "released" : "dispatched")
      if (!released) stillCommitted += 1n
    }
    const committed = (await totals(workspace))[0]!.committedUsd
    expect(committed).toBe(stillCommitted === 0n ? "0" : `0.${stillCommitted}`)
  })

  test("an unknown outcome keeps its commitment until a receipt settles it", async () => {
    const workspace = await seedEnforcedWorkspace()
    const attempt = await dispatched(workspace, { maxCostUsd: "0.4" })
    expect(await service.release(workspace, attempt.id, null)).toBe(false)
    expect(await service.markUnknown(workspace, attempt.id)).toBe(true)
    expect(await service.markUnknown(workspace, attempt.id)).toBe(false)
    expect(await service.release(workspace, attempt.id, null)).toBe(false)
    expect(await service.dispatch(workspace, attempt.id, null)).toEqual({
      dispatched: false,
      reason: "NOT_RESERVED",
      state: "unknown",
    })
    expect(await totals(workspace)).toEqual([{ settledUsd: "0", committedUsd: "0.4" }])

    const settled = await service.settle({
      workspaceId: workspace,
      attemptId: attempt.id,
      actualCostUsd: "0.15",
      receipt,
    })
    expect(settled).toEqual({ ...attempt, state: "settled", actualCostUsd: "0.15", receipt })
    expect(await totals(workspace)).toEqual([{ settledUsd: "0.15", committedUsd: "0" }])
  })
})

describe("settlement", () => {
  test("settles once at the exact vendor cost; an identical receipt is a no-op, a conflicting one is rejected", async () => {
    const workspace = await seedEnforcedWorkspace()
    const attempt = await dispatched(workspace, { maxCostUsd: "0.5" })
    const settle = (actualCostUsd: string, r: AISpendingReceipt = receipt) =>
      service.settle({ workspaceId: workspace, attemptId: attempt.id, actualCostUsd, receipt: r })

    const first = await settle("0.1234567")
    const [again, alsoAgain] = await Promise.all([settle("0.1234567"), settle("0.12345670")])
    expect(again).toEqual(first)
    expect(alsoAgain).toEqual(first)
    await expect(settle("0.12345671")).rejects.toBeInstanceOf(SpendReceiptConflictError)
    await expect(settle("0.1234567", { ...receipt, providerRequestId: "req_2" })).rejects.toBeInstanceOf(
      SpendReceiptConflictError
    )
    await expect(settle("0.1234567", { ...receipt, usage: { inputTokens: 120 } })).rejects.toBeInstanceOf(
      SpendReceiptConflictError
    )
    expect(await totals(workspace)).toEqual([{ settledUsd: "0.1234567", committedUsd: "0" }])
    expect(await service.getAttempt(workspace, attempt.id)).toEqual({
      ...attempt,
      state: "settled",
      actualCostUsd: "0.1234567",
      receipt,
    })
  })

  test("never-dispatched, released and unknown-id attempts cannot settle", async () => {
    const workspace = await seedEnforcedWorkspace()
    const reservedAttempt = await reserved(workspace)
    const releasedAttempt = await reserved(workspace)
    await service.release(workspace, releasedAttempt.id, null)
    for (const attemptId of [reservedAttempt.id, releasedAttempt.id, "ai_attempt_missing"]) {
      await expect(
        service.settle({ workspaceId: workspace, attemptId, actualCostUsd: "0.01", receipt })
      ).rejects.toBeInstanceOf(SpendAttemptStateError)
    }
    expect((await service.getAttempt(workspace, reservedAttempt.id))?.state).toBe("reserved")
    expect(await totals(workspace)).toEqual([{ settledUsd: "0", committedUsd: "0.1" }])
  })

  test("a charge above the reserved bound is recorded in full and latches the emergency stop", async () => {
    const workspace = await seedEnforcedWorkspace()
    const overrun = await dispatched(workspace, { maxCostUsd: "0.5" })
    const bystander = await reserved(workspace, { maxCostUsd: "0.1" })
    const settled = await service.settle({
      workspaceId: workspace,
      attemptId: overrun.id,
      actualCostUsd: "0.75",
      receipt,
    })
    expect(settled.actualCostUsd).toBe("0.75")
    expect(await totals(workspace)).toEqual([{ settledUsd: "0.75", committedUsd: "0.1" }])
    expect(await service.getPolicy(workspace)).toMatchObject({ version: 3, emergencyLatched: true })

    expect(await service.reserve(request(workspace))).toEqual({ allowed: false, reason: "EMERGENCY" })
    expect(await service.dispatch(workspace, bystander.id, null)).toEqual({ dispatched: false, reason: "EMERGENCY" })
    await expect(
      service.setPolicy(enforceInput(workspace, { expectedVersion: 2, agentCutoffUsd: "0.9" }))
    ).rejects.toBeInstanceOf(StaleSpendPolicyError)
    const edited = await service.setPolicy(enforceInput(workspace, { expectedVersion: 3, agentCutoffUsd: "0.9" }))
    expect(edited).toMatchObject({ version: 4, limits: { agentCutoffUsd: "0.9" }, emergencyLatched: true })
    expect(await service.reserve(request(workspace))).toEqual({ allowed: false, reason: "EMERGENCY" })

    const disabled = await service.setPolicy(disableInput(workspace, 4))
    expect(disabled).toMatchObject({ version: 5, status: "disabled", emergencyLatched: true })
    expect(await service.reserve(request(workspace))).toEqual({ allowed: false, reason: "EMERGENCY" })
    const reenforced = await service.setPolicy(enforceInput(workspace, { expectedVersion: 5 }))
    expect(reenforced).toMatchObject({ version: 6, status: "enforced", emergencyLatched: true })
    expect(await service.reserve(request(workspace))).toEqual({ allowed: false, reason: "EMERGENCY" })
    expect(await service.dispatch(workspace, bystander.id, null)).toEqual({ dispatched: false, reason: "EMERGENCY" })
  })

  test("a settlement whose period accounting cannot apply rolls back entirely", async () => {
    const workspace = await seedEnforcedWorkspace()
    const attempt = await dispatched(workspace, { maxCostUsd: "0.2" })
    await pool.query("DELETE FROM ai_spending_periods WHERE workspace_id = $1 AND id = $2", [
      workspace,
      attempt.periodId,
    ])
    await expect(
      service.settle({ workspaceId: workspace, attemptId: attempt.id, actualCostUsd: "0.1", receipt })
    ).rejects.toThrow(/Spend period .* missing/)
    expect(await service.getAttempt(workspace, attempt.id)).toEqual(attempt)
  })
})

describe("periods", () => {
  test("moving the timezone west does not grant a short extra period before local month rollover", async () => {
    const workspace = await seedEnforcedWorkspace(WIDE_CUTOFFS)
    await reserved(workspace)
    await WorkspaceSettingsRepository.setOverride(pool, workspace, "billingTimezone", "America/Los_Angeles")
    try {
      now = new Date("2026-10-01T00:30:00Z")
      const afterUtcRollover = await reserved(workspace)
      now = new Date("2026-10-01T08:00:00Z")
      const afterLocalRollover = await reserved(workspace)
      expect(afterLocalRollover.periodId).toBe(afterUtcRollover.periodId)
      expect((await service.listPeriods(workspace))[1]).toMatchObject({
        startsAt: new Date("2026-10-01T00:00:00Z"),
        endsAt: new Date("2026-11-01T07:00:00Z"),
        timezone: "America/Los_Angeles",
        committedUsd: "0.2",
      })
      now = new Date("2026-11-01T08:00:00Z")
      const november = await reserved(workspace)
      expect((await service.listPeriods(workspace))[2]).toMatchObject({
        id: november.periodId,
        startsAt: new Date("2026-11-01T07:00:00Z"),
        endsAt: new Date("2026-12-01T08:00:00Z"),
      })
    } finally {
      now = new Date("2026-09-16T10:00:00Z")
    }
  })

  test("a timezone edit moves only the next boundary; late receipts settle the original period", async () => {
    const workspace = await seedEnforcedWorkspace(WIDE_CUTOFFS)
    const september = await dispatched(workspace, { maxCostUsd: "0.5" })
    const [first] = await service.listPeriods(workspace)
    expect(first).toMatchObject({
      startsAt: new Date("2026-09-01T00:00:00Z"),
      endsAt: new Date("2026-10-01T00:00:00Z"),
      timezone: "UTC",
      committedUsd: "0.5",
    })

    await WorkspaceSettingsRepository.setOverride(pool, workspace, "billingTimezone", "Asia/Tokyo")
    await reserved(workspace, { maxCostUsd: "0.1" })
    expect(await service.listPeriods(workspace)).toEqual([{ ...first!, committedUsd: "0.6" }])

    now = new Date("2026-10-01T05:00:00Z")
    const october = await reserved(workspace, { maxCostUsd: "0.2" })
    await reserved(workspace, { maxCostUsd: "0.2" })
    const periods = await service.listPeriods(workspace)
    expect(periods).toEqual([
      { ...first!, committedUsd: "0.6" },
      {
        id: october.periodId,
        workspaceId: workspace,
        startsAt: new Date("2026-10-01T00:00:00Z"),
        endsAt: new Date("2026-10-31T15:00:00Z"),
        timezone: "Asia/Tokyo",
        settledUsd: "0",
        committedUsd: "0.4",
      },
    ])
    expect(october.periodId).not.toBe(september.periodId)

    await service.settle({ workspaceId: workspace, attemptId: september.id, actualCostUsd: "0.45", receipt })
    expect(await totals(workspace)).toEqual([
      { settledUsd: "0.45", committedUsd: "0.1" },
      { settledUsd: "0", committedUsd: "0.4" },
    ])
    now = new Date("2026-09-16T10:00:00Z")
  })

  test("concurrent first admissions open exactly one period", async () => {
    const workspace = await seedEnforcedWorkspace(WIDE_CUTOFFS)
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => service.reserve(request(workspace))))
    expect(outcomes.every((o) => o.allowed)).toBe(true)
    expect(new Set(outcomes.map((o) => (o.allowed ? o.attempt.periodId : "")))).toHaveProperty("size", 1)
    expect(await totals(workspace)).toEqual([{ settledUsd: "0", committedUsd: "0.8" }])
  })
})

describe("workspace isolation", () => {
  test("policies, keys, totals and settlement are scoped to their workspace", async () => {
    const alpha = await seedEnforcedWorkspace({ agentCutoffUsd: "0.5" })
    const beta = await seedEnforcedWorkspace({ agentCutoffUsd: "0.3" })
    const shared = { idempotencyKey: "shared-key", maxCostUsd: "0.3" }
    const alphaAttempt = await dispatched(alpha, shared)
    const betaAttempt = await reserved(beta, shared)
    expect(alphaAttempt.id).not.toBe(betaAttempt.id)

    expect(await service.reserve(request(beta, { maxCostUsd: "0.00000001" }))).toMatchObject({
      allowed: false,
      reason: "LIMIT_EXCEEDED",
    })
    expect((await service.reserve(request(alpha, { maxCostUsd: "0.2" }))).allowed).toBe(true)

    await expect(
      service.settle({ workspaceId: beta, attemptId: alphaAttempt.id, actualCostUsd: "0.1", receipt })
    ).rejects.toBeInstanceOf(SpendAttemptStateError)
    expect(await service.dispatch(alpha, betaAttempt.id, null)).toEqual({
      dispatched: false,
      reason: "NOT_RESERVED",
      state: null,
    })
    expect(await service.release(alpha, betaAttempt.id, null)).toBe(false)
    expect(await service.getAttempt(beta, alphaAttempt.id)).toBeNull()

    expect(await totals(alpha)).toEqual([{ settledUsd: "0", committedUsd: "0.5" }])
    expect(await totals(beta)).toEqual([{ settledUsd: "0", committedUsd: "0.3" }])
  })
})
