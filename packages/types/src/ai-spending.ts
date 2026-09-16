import { z } from "zod"

export const AI_SPENDING_STAGES = ["agent", "enrichment", "core", "embedding"] as const
export type AISpendingStage = (typeof AI_SPENDING_STAGES)[number]

/**
 * The paid work an operator acknowledges as metered when enforcing. Activation
 * must name this exact profile; anything outside it stays denied while enforced.
 */
const spendingRouteProfileSchema = z.object({
  model: z.string().min(1),
  providerSlug: z.string().min(1),
  maxPromptTokens: z.number().int().positive(),
  maxCompletionTokens: z.number().int().positive(),
  promptUsdPerToken: z.string(),
  completionUsdPerToken: z.string(),
  requestUsd: z.string(),
  supportedParameters: z.array(z.string()).readonly(),
})
export type SpendingRouteProfile = z.infer<typeof spendingRouteProfileSchema>

// OpenRouter's openai endpoint metadata, checked 2026-09-16. Full-context
// admission includes the highest advertised long-context/cache-write rates.
export const AI_SPENDING_COVERAGE = {
  profile: "assistant-text-v1",
  metered: ["assistant-text"],
  route: {
    model: "openai/gpt-5.6-luna",
    providerSlug: "openai",
    maxPromptTokens: 922_000,
    maxCompletionTokens: 128_000,
    promptUsdPerToken: "0.0000005",
    completionUsdPerToken: "0.0000018",
    requestUsd: "0",
    supportedParameters: [
      "reasoning",
      "include_reasoning",
      "seed",
      "max_tokens",
      "response_format",
      "structured_outputs",
      "tools",
      "tool_choice",
      "reasoning_effort",
    ],
  } satisfies SpendingRouteProfile,
} as const
type AISpendingCoverageProfile = (typeof AI_SPENDING_COVERAGE)["profile"]
type AISpendingCoverage = (typeof AI_SPENDING_COVERAGE)["metered"][number]

/**
 * The paid work the runtime can authorize, keyed by the purpose a host binds.
 * The purpose alone decides the restriction stage and the coverage it needs;
 * a caller never supplies a stage. Persisted attempts keep purpose as opaque
 * text, so a purpose removed here only stops new authorization. A purpose
 * with `execution: "session"` is only funded for a claimed session execution:
 * the ledger dispatches or releases it only while that generation still holds
 * the session.
 */
export const AI_SPENDING_PURPOSES = {
  assistant_turn: { stage: "agent", coverage: "assistant-text", execution: "session" },
} as const satisfies Record<
  string,
  { stage: AISpendingStage; coverage: AISpendingCoverage; execution: "session" | "none" }
>
export type AISpendingPurpose = keyof typeof AI_SPENDING_PURPOSES

/** The catalog entry for a purpose, or null when the value names no supported purpose. */
export function aiSpendingPurpose(purpose: unknown): (typeof AI_SPENDING_PURPOSES)[AISpendingPurpose] | null {
  return typeof purpose === "string" && Object.prototype.hasOwnProperty.call(AI_SPENDING_PURPOSES, purpose)
    ? AI_SPENDING_PURPOSES[purpose as AISpendingPurpose]
    : null
}

/** USD amounts are exact decimal strings with at most 8 fractional digits, never floats. */
export interface AISpendingLimits {
  agentCutoffUsd: string
  enrichmentCutoffUsd: string
  coreCutoffUsd: string
  embeddingCutoffUsd: string
  operatorCeilingUsd: string
}

interface AISpendingPolicyState {
  workspaceId: string
  version: number
  emergencyLatched: boolean
  statusChangedAt: Date
  /** Operator who last changed `status`; null when provisioning recorded it. */
  statusChangedBy: string | null
  /** Operator behind the latest edit; null when provisioning recorded it. */
  updatedBy: string | null
}

/**
 * - `unprotected`: legacy behaviour, recorded explicitly; the ledger admits nothing.
 * - `disabled`: every paid attempt is denied.
 * - `enforced`: supported attempts are admitted against the configured limits.
 *
 * Non-enforced policies may keep the last configured limits for display; they are never applied.
 */
export type AISpendingPolicy =
  | (AISpendingPolicyState & {
      status: "unprotected" | "disabled"
      limits: AISpendingLimits | null
      coverageProfile: AISpendingCoverageProfile | null
    })
  | (AISpendingPolicyState & {
      status: "enforced"
      limits: AISpendingLimits
      coverageProfile: AISpendingCoverageProfile
    })

interface AISpendingPolicyChange {
  workspaceId: string
  /** 0 creates a missing policy; any other value edits that exact version. */
  expectedVersion: number
  /** Trusted operator identity forwarded by the control plane, never client-supplied. */
  operatorWorkosUserId: string
}

/** Operator edits never set `unprotected`; that state is only ever provisioned. */
export type AISpendingPolicyInput =
  | (AISpendingPolicyChange & { status: "disabled" })
  | (AISpendingPolicyChange & {
      status: "enforced"
      limits: AISpendingLimits
      /** Must equal `AI_SPENDING_COVERAGE.profile`; checked, not assumed. */
      coverageProfile: string
    })

export interface AISpendingPeriod {
  id: string
  workspaceId: string
  startsAt: Date
  endsAt: Date
  timezone: string
  settledUsd: string
  committedUsd: string
}

const AI_SPENDING_ATTEMPT_STATES = ["reserved", "dispatched", "unknown", "settled", "released"] as const
export type AISpendingAttemptState = (typeof AI_SPENDING_ATTEMPT_STATES)[number]

/** Immutable identity of one paid attempt; a repeated `idempotencyKey` must carry the same values. */
export interface AISpendingAttemptRequest {
  workspaceId: string
  idempotencyKey: string
  sponsorUserId: string
  sessionId: string | null
  operationId: string
  purpose: string
  stage: AISpendingStage
  model: string
  providerRoute: string
  provider: string
  functionId: string
  /** Host-computed upper bound for the attempt; the ledger never estimates it. */
  maxCostUsd: string
}

/** Accounting metadata only — provider ids and numeric usage, never prompt or response text. */
export interface AISpendingReceipt {
  providerRequestId: string | null
  reportedCostUsd?: string
  usage: Record<string, number>
}

export interface AISpendingAttempt extends AISpendingAttemptRequest {
  id: string
  periodId: string
  state: AISpendingAttemptState
  actualCostUsd: string | null
  receipt: AISpendingReceipt | null
}

export type AISpendingDenialReason = "NOT_PROVISIONED" | "NOT_ENFORCED" | "DISABLED" | "EMERGENCY" | "LIMIT_EXCEEDED"

/** Every code a spending denial can carry: the ledger's reasons plus the runtime's own refusals. */
export type AISpendingDenialCode =
  | AISpendingDenialReason
  | "MISSING_CONTEXT"
  | "UNKNOWN_ROUTE"
  | "UNSUPPORTED_OPERATION"
  | "REQUEST_NOT_BOUNDED"
  | "POLICY_CHANGED"

const usdAmountSchema = z.string().min(1)

const aiSpendingLimitsSchema = z.strictObject({
  agentCutoffUsd: usdAmountSchema,
  enrichmentCutoffUsd: usdAmountSchema,
  coreCutoffUsd: usdAmountSchema,
  embeddingCutoffUsd: usdAmountSchema,
  operatorCeilingUsd: usdAmountSchema,
}) satisfies z.ZodType<AISpendingLimits>

const policyChangeShape = { expectedVersion: z.number().int().nonnegative() }
const operatorShape = { operatorWorkosUserId: z.string().min(1) }
const enforcedChangeShape = {
  ...policyChangeShape,
  status: z.literal("enforced"),
  limits: aiSpendingLimitsSchema,
  /** Validated against `AI_SPENDING_COVERAGE` by the region, so a mismatch is a 409, not a parse error. */
  coverageProfile: z.string().min(1),
}

/**
 * Operator edit as the backoffice sends it. The workspace comes from the path
 * and the operator from the session; unknown fields are rejected so neither
 * can be forged through the body. There is no `unprotected` variant.
 */
export const aiSpendingPolicyUpdateSchema = z.discriminatedUnion("status", [
  z.strictObject({ ...policyChangeShape, status: z.literal("disabled") }),
  z.strictObject(enforcedChangeShape),
])
export type AISpendingPolicyUpdate = z.infer<typeof aiSpendingPolicyUpdateSchema>

/** Control plane → owning region command: the operator edit plus the authenticated operator identity. */
export const aiSpendingInternalPolicyUpdateSchema = z.discriminatedUnion("status", [
  z.strictObject({ ...policyChangeShape, ...operatorShape, status: z.literal("disabled") }),
  z.strictObject({ ...enforcedChangeShape, ...operatorShape }),
])
export type AISpendingInternalPolicyUpdate = z.infer<typeof aiSpendingInternalPolicyUpdateSchema>

const coverageProfileSchema = z.literal(AI_SPENDING_COVERAGE.profile)
const policyStateShape = {
  workspaceId: z.string(),
  version: z.number().int().nonnegative(),
  emergencyLatched: z.boolean(),
  statusChangedAt: z.iso.datetime(),
  statusChangedBy: z.string().nullable(),
  updatedBy: z.string().nullable(),
}

/** `AISpendingPolicy` on the wire: amounts stay exact decimal strings, dates are ISO strings. */
const aiSpendingPolicyWireSchema = z.discriminatedUnion("status", [
  z.strictObject({
    ...policyStateShape,
    status: z.enum(["unprotected", "disabled"]),
    limits: aiSpendingLimitsSchema.nullable(),
    coverageProfile: coverageProfileSchema.nullable(),
  }),
  z.strictObject({
    ...policyStateShape,
    status: z.literal("enforced"),
    limits: aiSpendingLimitsSchema,
    coverageProfile: coverageProfileSchema,
  }),
])
export type AISpendingPolicyWire = z.infer<typeof aiSpendingPolicyWireSchema>

const aiSpendingPeriodWireSchema = z.strictObject({
  id: z.string(),
  workspaceId: z.string(),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  timezone: z.string(),
  settledUsd: usdAmountSchema,
  committedUsd: usdAmountSchema,
})
export type AISpendingPeriodWire = z.infer<typeof aiSpendingPeriodWireSchema>

/**
 * The owning region's authoritative spending state. `policy` null means no
 * policy row exists, which is distinct from an explicit `unprotected` policy.
 * `currentPeriod` null means nothing has been reserved this period; reads never create one.
 */
export const aiSpendingOverviewSchema = z.strictObject({
  workspaceId: z.string(),
  policy: aiSpendingPolicyWireSchema.nullable(),
  currentPeriod: aiSpendingPeriodWireSchema.nullable(),
  coverage: z.strictObject({
    profile: coverageProfileSchema,
    metered: z.array(z.enum(AI_SPENDING_COVERAGE.metered)).readonly(),
    route: spendingRouteProfileSchema,
  }),
})
export type AISpendingOverview = z.infer<typeof aiSpendingOverviewSchema>

/** A saved edit: the policy exactly as the region stored it, including its new version. */
export const aiSpendingPolicyUpdateResultSchema = z.strictObject({ policy: aiSpendingPolicyWireSchema })
export type AISpendingPolicyUpdateResult = z.infer<typeof aiSpendingPolicyUpdateResultSchema>
