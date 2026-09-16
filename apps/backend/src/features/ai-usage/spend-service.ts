import type { Pool } from "pg"
import {
  AI_SPENDING_COVERAGE,
  AI_SPENDING_STAGES,
  type AISpendingAttempt,
  type AISpendingAttemptRequest,
  type AISpendingAttemptState,
  type AISpendingDenialReason,
  type AISpendingPeriod,
  type AISpendingPolicy,
  type AISpendingLimits,
  type AISpendingPolicyInput,
  type AISpendingReceipt,
  type AISpendingStage,
} from "@threahq/types"
import { withClient, withTransaction, type Querier } from "../../db"
import { aiBudgetId, aiSpendAttemptId, aiSpendPeriodId, aiUsageId } from "../../lib/id"
import { AIUsageRepository } from "./usage-repository"
import { AIBudgetRepository, type UpdateAIBudgetParams } from "./budget-repository"
import { monthRangeInTimezone } from "../../lib/temporal"
import { resolveBillingTimezone } from "./billing-window"
import { SpendingDeniedError, compareUsd, usd, usdString, usdUnits } from "@threahq/agent-runtime"
import { limitsAreOrdered, orderedLimitValues, SpendPolicyRepository } from "./spend-policy-repository"
import { SpendRepository } from "./spend-repository"
import { AgentSessionRepository, CompanionExecutionLostError } from "../agents"

export class StaleSpendPolicyError extends Error {
  readonly code = "STALE_SPEND_POLICY" as const
  constructor(workspaceId: string, expectedVersion: number) {
    super(`Spending policy for ${workspaceId} is not at version ${expectedVersion}`)
  }
}

export class InvalidSpendPolicyError extends Error {
  readonly code = "INVALID_SPEND_POLICY" as const
}

/** Enforcing requires acknowledging exactly the coverage this build meters. */
export class SpendCoverageNotAcknowledgedError extends Error {
  readonly code = "SPEND_COVERAGE_NOT_ACKNOWLEDGED" as const
  constructor(received: unknown) {
    super(`Enforcing requires acknowledging coverage ${AI_SPENDING_COVERAGE.profile}; got ${String(received)}`)
  }
}

/** The same idempotency key arrived with different immutable identity fields. */
export class SpendAttemptConflictError extends Error {
  readonly code = "SPEND_ATTEMPT_CONFLICT" as const
}

/** A settled attempt received a second receipt that disagrees with the first. */
export class SpendReceiptConflictError extends Error {
  readonly code = "SPEND_RECEIPT_CONFLICT" as const
}

/** Settlement of an attempt that was never dispatched, or of an unknown attempt id. */
export class SpendAttemptStateError extends Error {
  readonly code = "SPEND_ATTEMPT_STATE" as const
}

interface LimitExceeded {
  reason: "LIMIT_EXCEEDED"
  stage: AISpendingStage
  cutoffUsd: string
  settledUsd: string
  committedUsd: string
}

export type ReserveOutcome =
  /** `created` is false when the idempotency key already named this attempt; it is returned in its current state. */
  | { allowed: true; created: boolean; attempt: AISpendingAttempt; period: AISpendingPeriod }
  | { allowed: false; reason: Exclude<AISpendingDenialReason, "LIMIT_EXCEEDED"> }
  | ({ allowed: false } & LimitExceeded)

export type DispatchOutcome =
  | { dispatched: true; attempt: AISpendingAttempt }
  | { dispatched: false; reason: Exclude<AISpendingDenialReason, "LIMIT_EXCEEDED"> }
  | ({ dispatched: false } & LimitExceeded)
  /** The attempt is no longer `reserved`; `state` is its current state, null when it does not exist. */
  | { dispatched: false; reason: "NOT_RESERVED"; state: AISpendingAttemptState | null }
  /** The caller's captured generation no longer holds the attempt's session for its sponsor. */
  | { dispatched: false; reason: "EXECUTION_LOST" }

export interface AISpendingServiceDeps {
  pool: Pool
  /** Injected so tests can move a workspace across period boundaries. */
  now?: () => Date
}

function stageCutoff(limits: AISpendingLimits, stage: AISpendingStage): string {
  switch (stage) {
    case "agent":
      return limits.agentCutoffUsd
    case "enrichment":
      return limits.enrichmentCutoffUsd
    case "core":
      return limits.coreCutoffUsd
    case "embedding":
      return limits.embeddingCutoffUsd
  }
}

/**
 * The one admission comparison: the period's settled total plus its
 * outstanding commitments plus `additionalUsd` must fit both the stage cutoff
 * and the operator ceiling. Reserve passes the new bound; dispatch passes zero
 * because the attempt's own bound is already inside `committedUsd`.
 */
function exceededLimit(
  limits: AISpendingLimits,
  stage: AISpendingStage,
  period: AISpendingPeriod,
  additionalUsd: string
): LimitExceeded | null {
  const cutoffUsd = stageCutoff(limits, stage)
  const projected = usdUnits(period.settledUsd) + usdUnits(period.committedUsd) + usdUnits(additionalUsd)
  if (projected <= usdUnits(cutoffUsd) && projected <= usdUnits(limits.operatorCeilingUsd)) return null
  return {
    reason: "LIMIT_EXCEEDED",
    stage,
    cutoffUsd,
    settledUsd: period.settledUsd,
    committedUsd: period.committedUsd,
  }
}

const LIMIT_FIELDS = [
  "agentCutoffUsd",
  "enrichmentCutoffUsd",
  "coreCutoffUsd",
  "embeddingCutoffUsd",
  "operatorCeilingUsd",
] as const satisfies readonly (keyof AISpendingLimits)[]

function validateLimits(limits: AISpendingLimits | undefined): AISpendingLimits {
  if (!limits) throw new InvalidSpendPolicyError("Enforcing requires all five limits")
  for (const field of LIMIT_FIELDS) {
    if (typeof limits[field] !== "string") throw new InvalidSpendPolicyError(`Enforcing requires ${field}`)
  }
  const normalized: AISpendingLimits = {
    agentCutoffUsd: usd(limits.agentCutoffUsd),
    enrichmentCutoffUsd: usd(limits.enrichmentCutoffUsd),
    coreCutoffUsd: usd(limits.coreCutoffUsd),
    embeddingCutoffUsd: usd(limits.embeddingCutoffUsd),
    operatorCeilingUsd: usd(limits.operatorCeilingUsd),
  }
  if (!limitsAreOrdered(normalized)) {
    throw new InvalidSpendPolicyError(
      `Cutoffs must be ordered ${AI_SPENDING_STAGES.join(" <= ")} <= operator ceiling; got ${orderedLimitValues(normalized).join(", ")}`
    )
  }
  return normalized
}

function validatePolicyInput(input: AISpendingPolicyInput): AISpendingPolicyInput {
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new InvalidSpendPolicyError("expectedVersion must be a non-negative integer")
  }
  if (typeof input.operatorWorkosUserId !== "string" || input.operatorWorkosUserId.trim() === "") {
    throw new InvalidSpendPolicyError("A policy change requires the operator identity")
  }
  const change = {
    workspaceId: input.workspaceId,
    expectedVersion: input.expectedVersion,
    operatorWorkosUserId: input.operatorWorkosUserId,
  }
  switch (input.status) {
    case "disabled":
      return { ...change, status: "disabled" }
    case "enforced":
      if (input.coverageProfile !== AI_SPENDING_COVERAGE.profile) {
        throw new SpendCoverageNotAcknowledgedError(input.coverageProfile)
      }
      return {
        ...change,
        status: "enforced",
        limits: validateLimits(input.limits),
        coverageProfile: input.coverageProfile,
      }
    default:
      throw new InvalidSpendPolicyError(
        `An operator can set a policy to disabled or enforced, not ${String((input as { status: unknown }).status)}`
      )
  }
}

function sameIdentity(existing: AISpendingAttempt, request: AISpendingAttemptRequest): boolean {
  return (
    existing.sponsorUserId === request.sponsorUserId &&
    existing.sessionId === request.sessionId &&
    existing.operationId === request.operationId &&
    existing.purpose === request.purpose &&
    existing.stage === request.stage &&
    existing.model === request.model &&
    existing.providerRoute === request.providerRoute &&
    existing.provider === request.provider &&
    existing.functionId === request.functionId &&
    compareUsd(existing.maxCostUsd, request.maxCostUsd) === 0
  )
}

function sameReceipt(a: AISpendingReceipt, b: AISpendingReceipt): boolean {
  if (a.providerRequestId !== b.providerRequestId) return false
  const keys = Object.keys(a.usage).sort()
  if (keys.length !== Object.keys(b.usage).length) return false
  return keys.every((key) => Object.prototype.hasOwnProperty.call(b.usage, key) && a.usage[key] === b.usage[key])
}

/**
 * Exact-money admission ledger for paid AI attempts. Every mutation runs in
 * one short transaction under the workspace anchor lock and never spans a
 * provider call (INV-41): callers reserve, dispatch, then talk to the vendor,
 * then settle or mark unknown.
 */
export class AISpendingService {
  private readonly pool: Pool
  private readonly now: () => Date

  constructor(deps: AISpendingServiceDeps) {
    this.pool = deps.pool
    this.now = deps.now ?? (() => new Date())
  }

  /**
   * Operator view of one workspace: its policy (null when no row exists) and
   * the period containing now (null until something reserves). Never creates
   * a period. Null when the workspace does not exist in this region.
   */
  async getOverview(
    workspaceId: string
  ): Promise<{ policy: AISpendingPolicy | null; currentPeriod: AISpendingPeriod | null } | null> {
    return withClient(this.pool, async (client) => {
      if (!(await SpendRepository.workspaceExists(client, workspaceId))) return null
      const policy = await SpendPolicyRepository.findByWorkspace(client, workspaceId)
      const currentPeriod = await SpendRepository.findPeriodAt(client, workspaceId, this.now())
      return { policy, currentPeriod }
    })
  }

  async updateLegacyBudget(workspaceId: string, updates: UpdateAIBudgetParams) {
    return withTransaction(this.pool, async (db) => {
      await SpendRepository.lockWorkspace(db, workspaceId)
      await this.assertUnprotected(workspaceId, db)
      return AIBudgetRepository.upsertPartial(db, { ...updates, id: aiBudgetId(), workspaceId })
    })
  }

  async assertUnprotected(workspaceId: string, db: Querier = this.pool): Promise<void> {
    const policy = await SpendPolicyRepository.findByWorkspace(db, workspaceId)
    const denial = policyDenial(policy)
    if (denial) throw new SpendingDeniedError(denial)
    if (policy?.status !== "unprotected") throw new SpendingDeniedError("UNSUPPORTED_OPERATION")
  }

  async getPolicy(workspaceId: string): Promise<AISpendingPolicy | null> {
    return SpendPolicyRepository.findByWorkspace(this.pool, workspaceId)
  }

  /**
   * Operator change to `disabled` or `enforced`: creates a never-provisioned
   * policy at `expectedVersion` 0, otherwise edits exactly `expectedVersion`.
   * Concurrent writers get `StaleSpendPolicyError`. No edit returns a
   * workspace to `unprotected` or clears an emergency latch.
   */
  async setPolicy(input: AISpendingPolicyInput): Promise<AISpendingPolicy> {
    const policy = validatePolicyInput(input)
    return withTransaction(this.pool, async (tx) => {
      await SpendRepository.lockWorkspace(tx, policy.workspaceId)
      const saved =
        policy.expectedVersion === 0
          ? await SpendPolicyRepository.insert(tx, policy)
          : await SpendPolicyRepository.updateAtVersion(tx, policy)
      if (!saved) throw new StaleSpendPolicyError(policy.workspaceId, policy.expectedVersion)
      return saved
    })
  }

  /**
   * Admit one attempt against the current period. The workspace anchor lock
   * serializes every reserve, and the unique (workspace, idempotency key)
   * index backs it, so concurrent callers with one key get one row: the first
   * creates it, the rest receive it as `created: false` in its current state
   * without re-reserving. Differing identity under the same key throws.
   */
  async reserve(request: AISpendingAttemptRequest): Promise<ReserveOutcome> {
    const maxCostUsd = usd(request.maxCostUsd)
    return withTransaction(this.pool, async (tx) => {
      await SpendRepository.lockWorkspace(tx, request.workspaceId)
      const policy = admissionPolicy(await SpendPolicyRepository.findByWorkspace(tx, request.workspaceId))
      if (typeof policy === "string") return { allowed: false, reason: policy }

      const existing = await SpendRepository.findAttemptByKey(tx, request.workspaceId, request.idempotencyKey)
      if (existing) {
        if (!sameIdentity(existing, { ...request, maxCostUsd })) {
          throw new SpendAttemptConflictError(
            `Idempotency key ${request.idempotencyKey} already reserved with a different identity`
          )
        }
        const period = await SpendRepository.findPeriodById(tx, request.workspaceId, existing.periodId)
        if (!period) throw new Error(`Spend period ${existing.periodId} missing for attempt ${existing.id}`)
        return { allowed: true, created: false, attempt: existing, period }
      }

      const authorizedAt = this.now()
      const period = await this.currentPeriod(tx, request.workspaceId, authorizedAt)
      const exceeded = exceededLimit(policy.limits, request.stage, period, maxCostUsd)
      if (exceeded) return { allowed: false, ...exceeded }

      const attempt = await SpendRepository.insertReservation(tx, {
        ...request,
        maxCostUsd,
        id: aiSpendAttemptId(),
        periodId: period.id,
        createdAt: authorizedAt,
      })
      const committedUsd = usdString(usdUnits(period.committedUsd) + usdUnits(maxCostUsd))
      return { allowed: true, created: true, attempt, period: { ...period, committedUsd } }
    })
  }

  /**
   * Pin dispatch ownership before egress. Under the anchor it rechecks status
   * and latch, then the current limits against the attempt's own pinned period
   * (its bound is already committed there), so a policy lowered after reserve
   * stops the attempt before anything is sent. The state CAS lets one caller win.
   * A session-bound attempt dispatches only for the generation that still holds
   * its session, and that session row stays locked until the CAS commits.
   */
  async dispatch(workspaceId: string, attemptId: string, executionGeneration: number | null): Promise<DispatchOutcome> {
    return withTransaction(this.pool, async (tx) => {
      if (!(await holdsExecution(tx, workspaceId, attemptId, executionGeneration))) {
        return { dispatched: false, reason: "EXECUTION_LOST" }
      }
      await SpendRepository.lockWorkspace(tx, workspaceId)
      const policy = admissionPolicy(await SpendPolicyRepository.findByWorkspace(tx, workspaceId))
      if (typeof policy === "string") return { dispatched: false, reason: policy }
      const reserved = await SpendRepository.findAttemptById(tx, workspaceId, attemptId)
      if (reserved?.state !== "reserved") {
        return { dispatched: false, reason: "NOT_RESERVED", state: reserved?.state ?? null }
      }
      const period = await SpendRepository.findPeriodById(tx, workspaceId, reserved.periodId)
      if (!period) throw new Error(`Spend period ${reserved.periodId} missing for attempt ${attemptId}`)
      const exceeded = exceededLimit(policy.limits, reserved.stage, period, "0")
      if (exceeded) return { dispatched: false, ...exceeded }
      const attempt = await SpendRepository.transition(tx, workspaceId, attemptId, "reserved", "dispatched")
      if (!attempt) throw new Error(`Attempt ${attemptId} left reserved while the workspace anchor was held`)
      return { dispatched: true, attempt }
    })
  }

  /**
   * Frees a never-dispatched reservation. Dispatched, unknown and settled
   * attempts keep their commitment, and a session-bound reservation is never
   * freed by a generation that lost the session: the replacement may be using it.
   */
  async release(workspaceId: string, attemptId: string, executionGeneration: number | null): Promise<boolean> {
    return withTransaction(this.pool, async (tx) => {
      if (!(await holdsExecution(tx, workspaceId, attemptId, executionGeneration))) return false
      await SpendRepository.lockWorkspace(tx, workspaceId)
      return (await SpendRepository.releaseReservation(tx, workspaceId, attemptId)) !== null
    })
  }

  /** A dispatched attempt whose outcome was lost stays committed until a receipt settles it. */
  async markUnknown(workspaceId: string, attemptId: string, receipt?: AISpendingReceipt): Promise<boolean> {
    return SpendRepository.markUnknown(this.pool, workspaceId, attemptId, receipt)
  }

  /**
   * Record the exact vendor charge. Idempotent for an identical receipt; a
   * conflicting receipt throws. A charge above the reserved bound is recorded
   * in full and latches the workspace's emergency stop.
   */
  async settle(params: {
    workspaceId: string
    attemptId: string
    actualCostUsd: string
    receipt: AISpendingReceipt
  }): Promise<AISpendingAttempt> {
    const actualCostUsd = usd(params.actualCostUsd)
    return withTransaction(this.pool, async (tx) => {
      await SpendRepository.lockWorkspace(tx, params.workspaceId)
      const settled = await SpendRepository.settleAttempt(tx, { ...params, actualCostUsd })
      if (settled) {
        await AIUsageRepository.projectSpendingSettlement(tx, {
          id: aiUsageId(),
          workspaceId: params.workspaceId,
          attemptId: settled.id,
        })
        if (compareUsd(actualCostUsd, settled.maxCostUsd) > 0) {
          await SpendPolicyRepository.latchEmergency(tx, params.workspaceId)
        }
        return settled
      }

      const existing = await SpendRepository.findAttemptById(tx, params.workspaceId, params.attemptId)
      if (existing?.state === "settled" && existing.actualCostUsd !== null && existing.receipt !== null) {
        if (compareUsd(existing.actualCostUsd, actualCostUsd) === 0 && sameReceipt(existing.receipt, params.receipt)) {
          return existing
        }
        throw new SpendReceiptConflictError(`Attempt ${params.attemptId} already settled with a different receipt`)
      }
      throw new SpendAttemptStateError(
        `Attempt ${params.attemptId} is ${existing?.state ?? "missing"}; only dispatched or unknown attempts settle`
      )
    })
  }

  async getAttempt(workspaceId: string, attemptId: string): Promise<AISpendingAttempt | null> {
    return SpendRepository.findAttemptById(this.pool, workspaceId, attemptId)
  }

  async listPeriods(workspaceId: string): Promise<AISpendingPeriod[]> {
    return SpendRepository.listPeriods(this.pool, workspaceId)
  }

  /**
   * The period containing `now`, created under the anchor lock when absent. A
   * new period starts exactly where the latest one ended, so a timezone edit
   * moves only the next boundary and never reopens or overlaps an old one.
   */
  private async currentPeriod(tx: Querier, workspaceId: string, now: Date): Promise<AISpendingPeriod> {
    const current = await SpendRepository.findPeriodAt(tx, workspaceId, now)
    if (current) return current
    const timezone = await resolveBillingTimezone(tx, workspaceId)
    const month = monthRangeInTimezone(timezone, now)
    const latest = await SpendRepository.findLatestPeriod(tx, workspaceId)
    let endsAt = month.end
    if (latest) {
      const nextMonth = monthRangeInTimezone(latest.timezone, latest.endsAt)
      const midpoint = new Date((latest.endsAt.getTime() + nextMonth.end.getTime()) / 2)
      // Preserve the next billing month's identity across timezone changes;
      // moving west must not create a short extra allowance before local midnight.
      const adjustedEnd = monthRangeInTimezone(timezone, midpoint).end
      if (adjustedEnd > endsAt) endsAt = adjustedEnd
    }
    return SpendRepository.insertPeriod(tx, {
      id: aiSpendPeriodId(),
      workspaceId,
      startsAt: latest ? latest.endsAt : month.start,
      endsAt,
      timezone,
    })
  }
}

/**
 * Locks the attempt's session at the caller's captured generation for the
 * attempt's sponsor, before the workspace anchor (session before anchor, like
 * session before stream). Session id and sponsor are immutable attempt fields,
 * so reading them unlocked is safe. A sessionless attempt needs no generation,
 * and a generation offered for one is a mismatch. A missing attempt is left to
 * the caller's own state check.
 */
async function holdsExecution(
  tx: Querier,
  workspaceId: string,
  attemptId: string,
  executionGeneration: number | null
): Promise<boolean> {
  const attempt = await SpendRepository.findAttemptById(tx, workspaceId, attemptId)
  if (!attempt) return true
  if (attempt.sessionId === null) return executionGeneration === null
  if (executionGeneration === null) return false
  try {
    await AgentSessionRepository.lockHeldExecution(
      tx,
      { sessionId: attempt.sessionId, generation: executionGeneration },
      { workspaceId, sponsorUserId: attempt.sponsorUserId }
    )
    return true
  } catch (error) {
    if (error instanceof CompanionExecutionLostError) return false
    throw error
  }
}

type AdmissionGate = Exclude<AISpendingDenialReason, "LIMIT_EXCEEDED">
type EnforcedSpendingPolicy = Extract<AISpendingPolicy, { status: "enforced" }>

/** The refusal every policy reader shares, whatever it then does with the status. The latch outranks every status. */
export function policyDenial(
  policy: AISpendingPolicy | null
): Extract<AISpendingDenialReason, "NOT_PROVISIONED" | "EMERGENCY" | "DISABLED"> | null {
  if (!policy) return "NOT_PROVISIONED"
  if (policy.emergencyLatched) return "EMERGENCY"
  return policy.status === "disabled" ? "DISABLED" : null
}

/**
 * Only an enforced, unlatched policy admits. `unprotected` is denied too: the
 * ledger never meters-and-allows legacy traffic, which the host routes itself.
 */
function admissionPolicy(policy: AISpendingPolicy | null): EnforcedSpendingPolicy | AdmissionGate {
  const denial = policyDenial(policy)
  if (denial) return denial
  return policy?.status === "enforced" ? policy : "NOT_ENFORCED"
}
