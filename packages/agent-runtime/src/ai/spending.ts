/**
 * Bounded provider transport: one guarded fetch per physical attempt sees the
 * final wire body, reserves and pins dispatch before egress, and records the
 * receipt before the SDK parses the response.
 */

import {
  aiSpendingPurpose,
  type AISpendingAttemptRequest,
  type AISpendingAttemptState,
  type AISpendingDenialCode,
  type AISpendingDenialReason,
  type AISpendingPurpose,
  type AISpendingReceipt,
  type AISpendingStage,
  type SpendingRouteProfile,
} from "@threahq/types"
import { logger } from "../logger"
import { ceilUsd, usdForTokens, usdString, usdUnits } from "./money"

/**
 * Who pays and why, bound by the host from its own authority — never derived
 * from telemetry or model arguments. The purpose decides the stage through
 * `AI_SPENDING_PURPOSES`; there is no caller-supplied stage.
 */
export interface SpendingContext {
  workspaceId: string
  /** Sponsor whose allowance funds the attempt. */
  userId: string
  sessionId: string | null
  /**
   * The session execution generation the host claimed, captured once at claim
   * and never re-read. Required exactly when `sessionId` is set: the ledger
   * dispatches or releases the attempt only while this generation still holds
   * the session for the sponsor. Not part of the idempotency key, so a
   * replacement generation recovers the same logical request.
   */
  executionGeneration: number | null
  /** Durable root operation (turn, job) that owns every physical attempt made for it. */
  operationId: string
  purpose: AISpendingPurpose
}

/**
 * One logical paid request inside a root operation. `requestKey` is derived by
 * the server from deterministic position (for example the agent loop
 * iteration), so a concurrent worker or a crash replay of the same step names
 * the same ledger attempt and can never buy the inference twice.
 */
export interface SpendingRequest extends SpendingContext {
  requestKey: string
}

/** The ledger idempotency key for one logical request; length-prefixed so no two (operation, key) pairs collide. */
function spendingIdempotencyKey(operationId: string, requestKey: string): string {
  return `op:${operationId.length}:${operationId}:req:${requestKey}`
}

export type { SpendingRouteProfile } from "@threahq/types"

/** How one physical attempt left the ledger. `held` keeps the full reservation committed until reconciliation. */
export type SpendingAttemptOutcome =
  | { attemptId: string; status: "settled" }
  | { attemptId: string; status: "held"; reason: SpendingHoldReason; providerRequestSent: boolean }

export type SpendingHoldReason =
  | "dispatch_failed"
  | "provider_request_failed"
  | "response_unreadable"
  | "cost_unavailable"
  | "settlement_failed"

export interface SpendingQuote {
  model: string
  providerRoute: string
  maxTokens: number
  maxCostUsd: string
}

/** A ledger refusal; the amounts accompany `LIMIT_EXCEEDED`. */
interface SpendingLedgerDenial {
  reason: AISpendingDenialReason
  stage?: AISpendingStage
  cutoffUsd?: string
  settledUsd?: string
  committedUsd?: string
}

export type SpendingReserveOutcome =
  /** `created` is false when the idempotency key already named an attempt, in whatever state it now is. */
  | { allowed: true; created: boolean; attempt: { id: string; state: AISpendingAttemptState } }
  | ({ allowed: false } & SpendingLedgerDenial)

export type SpendingDispatchOutcome =
  | { dispatched: true }
  | ({ dispatched: false } & SpendingLedgerDenial)
  /** Someone else already moved the attempt on; `state` is what it is now, null when it does not exist. */
  | { dispatched: false; reason: "NOT_RESERVED"; state: AISpendingAttemptState | null }
  /** The caller's captured generation no longer holds the attempt's session for its sponsor. */
  | { dispatched: false; reason: "EXECUTION_LOST" }

/**
 * A workspace's persisted spending policy as a data decision. Only an explicit
 * `unprotected` policy keeps legacy unmetered egress; a missing, disabled or
 * emergency-latched policy is a denial; `protected` with no denial is enforced.
 */
export type SpendingPolicyMode =
  | { mode: "unprotected" }
  | { mode: "protected"; denial: Extract<AISpendingDenialReason, "NOT_PROVISIONED" | "DISABLED" | "EMERGENCY"> | null }

/** Host adapter over the spending ledger; shape matches `AISpendingService` plus route resolution. */
export interface SpendingGate {
  /** One uncached policy read; the runtime calls it per AI call and again before every legacy physical request. */
  policyMode(workspaceId: string): Promise<SpendingPolicyMode>
  /** The approved profile for a requested OpenRouter model id, or null when no route is approved. */
  routeFor(request: { context: SpendingContext; modelId: string }): Promise<SpendingRouteProfile | null>
  reserve(request: AISpendingAttemptRequest): Promise<SpendingReserveOutcome>
  dispatch(workspaceId: string, attemptId: string, executionGeneration: number | null): Promise<SpendingDispatchOutcome>
  settle(params: {
    workspaceId: string
    attemptId: string
    actualCostUsd: string
    receipt: AISpendingReceipt
  }): Promise<unknown>
  release(workspaceId: string, attemptId: string, executionGeneration: number | null): Promise<unknown>
  markUnknown(workspaceId: string, attemptId: string, receipt?: AISpendingReceipt): Promise<unknown>
}

export class SpendingDeniedError extends Error {
  readonly name = "SpendingDeniedError"
  readonly code: AISpendingDenialCode
  readonly details: Record<string, unknown>

  constructor(code: AISpendingDenialCode, details: Record<string, unknown> = {}) {
    super(`AI spending denied: ${code}`)
    this.code = code
    this.details = details
  }
}

/**
 * The logical request is already owned by another attempt with the same
 * idempotency key: a concurrent worker won dispatch, or a replay found it
 * dispatched, settled, unknown or released. Nothing was sent and this caller
 * released nothing. It is not a failure of the winner's work; a host decides
 * whether its own run stops quietly or waits for the owner's result.
 */
export class SpendingDuplicateRequestError extends Error {
  readonly name = "SpendingDuplicateRequestError"
  readonly code = "DUPLICATE_REQUEST" as const
  readonly attemptId: string
  /** The owning attempt's state when this caller lost; null when it could not be read. */
  readonly state: AISpendingAttemptState | null

  constructor(attemptId: string, state: AISpendingAttemptState | null) {
    super(`AI spending request already owned by attempt ${attemptId} (${state ?? "state unknown"}); not sent`)
    this.attemptId = attemptId
    this.state = state
  }
}

/**
 * The session execution that bound this request no longer holds its session:
 * a replacement generation or a terminal state owns it. Nothing was sent and
 * nothing was released, so the current owner can still recover the same
 * logical request. The stale host stops without persisting a spending stop.
 */
export class SpendingExecutionLostError extends Error {
  readonly name = "SpendingExecutionLostError"
  readonly code = "EXECUTION_LOST" as const
  readonly attemptId: string

  constructor(attemptId: string) {
    super(`AI spending attempt ${attemptId} not sent: its session execution was replaced`)
    this.attemptId = attemptId
  }
}

export class SpendingResultUnavailableError extends Error {
  readonly name = "SpendingResultUnavailableError"
  readonly code = "RESULT_UNAVAILABLE" as const

  constructor(cause: unknown) {
    super("Paid AI result unavailable; do not replay", { cause })
  }
}

export class SpendingOutcomeUnknownError extends Error {
  readonly name = "SpendingOutcomeUnknownError"
  readonly code = "OUTCOME_UNKNOWN" as const
  readonly attempts: readonly SpendingAttemptOutcome[]

  constructor(attempts: readonly SpendingAttemptOutcome[], cause: unknown) {
    super("AI spending attempt outcome unknown; commitment retained, do not replay", { cause })
    this.attempts = attempts
  }
}

/** Bun's `typeof fetch` carries `preconnect`; transports only need the call signature. */
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export const OPENROUTER_CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions"

function invalidRoute(field: string): never {
  throw new SpendingDeniedError("UNKNOWN_ROUTE", { reason: "invalid route profile", field })
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function perMillion(ratePerToken: string, field: string): string {
  try {
    const value = usdForTokens(ratePerToken, 1_000_000)
    // A zero rate would make the reservation vacuous for a route that still bills.
    if (usdUnits(value) === 0n) invalidRoute(field)
    return value
  } catch (error) {
    if (error instanceof SpendingDeniedError) throw error
    invalidRoute(field)
  }
}

/** Bound one attempt: full published prompt maximum plus the completion cap the caller asked for. */
export function quoteAttempt(profile: SpendingRouteProfile, requestedMaxTokens: number | undefined): SpendingQuote {
  if (typeof profile.model !== "string" || profile.model === "") invalidRoute("model")
  if (typeof profile.providerSlug !== "string" || profile.providerSlug === "") invalidRoute("providerSlug")
  if (!isPositiveSafeInteger(profile.maxPromptTokens)) invalidRoute("maxPromptTokens")
  if (!isPositiveSafeInteger(profile.maxCompletionTokens)) invalidRoute("maxCompletionTokens")
  perMillion(profile.promptUsdPerToken, "promptUsdPerToken")
  perMillion(profile.completionUsdPerToken, "completionUsdPerToken")
  let requestUnits: bigint
  try {
    requestUnits = usdUnits(profile.requestUsd)
  } catch {
    invalidRoute("requestUsd")
  }

  const maxTokens = requestedMaxTokens ?? profile.maxCompletionTokens
  if (!isPositiveSafeInteger(maxTokens) || maxTokens > profile.maxCompletionTokens) {
    throw new SpendingDeniedError("REQUEST_NOT_BOUNDED", {
      field: "max_tokens",
      requested: requestedMaxTokens,
      maxCompletionTokens: profile.maxCompletionTokens,
    })
  }
  let maxCostUsd: string
  try {
    maxCostUsd = usdString(
      usdUnits(usdForTokens(profile.promptUsdPerToken, profile.maxPromptTokens)) +
        usdUnits(usdForTokens(profile.completionUsdPerToken, maxTokens)) +
        requestUnits
    )
  } catch {
    invalidRoute("maxCostUsd")
  }
  return { model: profile.model, providerRoute: profile.providerSlug, maxTokens, maxCostUsd }
}

/**
 * The `provider` object pinned onto every guarded request: one provider, no
 * fallbacks, no silently ignored parameters. `max_price` carries the quoted
 * per-million rates so OpenRouter skips the route once its advertised price
 * rises above them; that is a routing filter, not a guarantee on the charge.
 */
export function providerRouting(profile: SpendingRouteProfile): Record<string, unknown> {
  return {
    order: [profile.providerSlug],
    allow_fallbacks: false,
    require_parameters: true,
    max_price: {
      prompt: perMillion(profile.promptUsdPerToken, "promptUsdPerToken"),
      completion: perMillion(profile.completionUsdPerToken, "completionUsdPerToken"),
    },
  }
}

/**
 * Refuse a funding request the host did not fully bind; there is no implicit
 * payer and no implicit step. Only the known fields are copied, so a stage or
 * any other extra a caller attaches never reaches the ledger.
 */
export function assertSpendingRequest(request: SpendingRequest | undefined, functionId: string): SpendingRequest {
  const missing = !request
    ? ["context"]
    : (["workspaceId", "userId", "operationId", "requestKey"] as const).filter(
        (field) => typeof request[field] !== "string" || request[field] === ""
      )
  if (request && !aiSpendingPurpose(request.purpose)) missing.push("purpose")
  if (request && request.sessionId !== null && (typeof request.sessionId !== "string" || request.sessionId === "")) {
    missing.push("sessionId")
  } else if (request && aiSpendingPurpose(request.purpose)?.execution === "session" && request.sessionId === null) {
    missing.push("sessionId")
  }
  if (request) {
    const generation = request.executionGeneration
    const bound = Number.isSafeInteger(generation) && (generation as number) >= 0
    if (request.sessionId === null ? generation !== null : !bound) missing.push("executionGeneration")
  }
  if (missing.length > 0) throw new SpendingDeniedError("MISSING_CONTEXT", { functionId, fields: missing })
  const { workspaceId, userId, sessionId, executionGeneration, operationId, purpose, requestKey } = request!
  return Object.freeze({ workspaceId, userId, sessionId, executionGeneration, operationId, purpose, requestKey })
}

const ALLOWED_BODY_KEYS = new Set([
  "model",
  "messages",
  "tools",
  "tool_choice",
  "max_tokens",
  "temperature",
  "top_p",
  "top_k",
  "frequency_penalty",
  "presence_penalty",
  "seed",
  "stop",
  "reasoning",
  "include_reasoning",
  "usage",
  "provider",
  "parallel_tool_calls",
  "user",
])

const ALLOWED_REASONING_KEYS = new Set(["effort", "exclude", "enabled"])

const ALLOWED_MESSAGE_KEYS = new Set([
  "role",
  "content",
  "name",
  "tool_calls",
  "tool_call_id",
  "reasoning",
  "reasoning_details",
  "annotations",
  "cache_control",
])

const ALLOWED_ROLES = new Set(["system", "user", "assistant", "tool"])
const ALLOWED_TEXT_PART_KEYS = new Set(["type", "text", "cache_control"])
const ALLOWED_TOOL_KEYS = new Set(["type", "function"])
const ALLOWED_FUNCTION_KEYS = new Set(["name", "description", "parameters", "strict"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function deny(field: string, details: Record<string, unknown> = {}): never {
  throw new SpendingDeniedError("REQUEST_NOT_BOUNDED", { field, ...details })
}

function validateMessages(messages: unknown): void {
  if (!Array.isArray(messages) || messages.length === 0) deny("messages")
  messages.forEach((message, index) => {
    if (!isRecord(message) || !ALLOWED_ROLES.has(message.role as string)) deny(`messages[${index}]`)
    for (const key of Object.keys(message)) {
      if (!ALLOWED_MESSAGE_KEYS.has(key)) deny(`messages[${index}].${key}`)
    }
    const content = message.content
    if (typeof content === "string" || content === null || content === undefined) return
    if (!Array.isArray(content)) deny(`messages[${index}].content`)
    content.forEach((part, partIndex) => {
      if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") {
        deny(`messages[${index}].content[${partIndex}]`, { type: isRecord(part) ? part.type : typeof part })
      }
      for (const key of Object.keys(part)) {
        if (!ALLOWED_TEXT_PART_KEYS.has(key)) deny(`messages[${index}].content[${partIndex}].${key}`)
      }
    })
  })
}

function validateTools(tools: unknown): void {
  if (tools === undefined) return
  if (!Array.isArray(tools)) deny("tools")
  tools.forEach((tool, index) => {
    if (
      !isRecord(tool) ||
      tool.type !== "function" ||
      !isRecord(tool.function) ||
      typeof tool.function.name !== "string"
    ) {
      deny(`tools[${index}]`, { type: isRecord(tool) ? tool.type : typeof tool })
    }
    for (const key of Object.keys(tool)) {
      if (!ALLOWED_TOOL_KEYS.has(key)) deny(`tools[${index}].${key}`)
    }
    for (const key of Object.keys(tool.function)) {
      if (!ALLOWED_FUNCTION_KEYS.has(key)) deny(`tools[${index}].function.${key}`)
    }
  })
}

function validateProvider(provider: unknown, expected: Record<string, unknown>): void {
  if (!isRecord(provider)) deny("provider")
  const keys = new Set([...Object.keys(provider), ...Object.keys(expected)])
  for (const key of keys) {
    if (JSON.stringify(provider[key]) !== JSON.stringify(expected[key]))
      deny(`provider.${key}`, { value: provider[key] })
  }
}

/**
 * Assert the final wire body is exactly the quoted attempt: the approved
 * model on the pinned route, text-only content, function tools only, the
 * quoted output cap, and no key that could buy anything else (fallback
 * models, plugins, web search, service tiers, streaming, multi-choice).
 */
export function validateWireBody(body: unknown, profile: SpendingRouteProfile, quote: SpendingQuote): void {
  if (!isRecord(body)) deny("body")
  for (const key of Object.keys(body)) {
    if (!ALLOWED_BODY_KEYS.has(key)) deny(key, { reason: "not allowed on a bounded attempt" })
    if (!["model", "messages", "usage", "provider"].includes(key) && !profile.supportedParameters.includes(key)) {
      deny(key, { reason: "unsupported by the approved provider route" })
    }
  }
  if (body.model !== profile.model) deny("model", { value: body.model, expected: profile.model })
  if (body.max_tokens !== quote.maxTokens) deny("max_tokens", { value: body.max_tokens, expected: quote.maxTokens })
  if (!isRecord(body.usage) || body.usage.include !== true || Object.keys(body.usage).length !== 1) deny("usage")
  validateProvider(body.provider, providerRouting(profile))
  validateMessages(body.messages)
  validateTools(body.tools)
  if (body.reasoning !== undefined) {
    if (!isRecord(body.reasoning)) deny("reasoning")
    for (const key of Object.keys(body.reasoning)) {
      if (!ALLOWED_REASONING_KEYS.has(key)) deny(`reasoning.${key}`)
    }
  }
}

const RECEIPT_TOKEN_FIELDS = ["prompt_tokens", "completion_tokens", "total_tokens"] as const

/** A `cost` number kept as its JSON source text, so no digit is lost to a double. */
class RawJsonNumber {
  constructor(readonly source: string) {}
}

/**
 * Accounting metadata from a raw OpenRouter chat-completions response body:
 * the generation id and whitelisted token counts, never message content.
 * `costUsd` is null unless the provider reported a charge the ledger can store
 * and can trust; a missing charge is unknown, not zero. The charge is rounded
 * up from the exact JSON literal (JSON.parse source-text access); a runtime
 * without it yields no cost rather than a rounded double.
 */
export function parseReceipt(text: string): { receipt: AISpendingReceipt; costUsd: string | null } {
  let body: unknown
  try {
    body = JSON.parse(text, (key: string, value: unknown, context?: { source?: string }) =>
      key === "cost" && typeof value === "number" && typeof context?.source === "string"
        ? new RawJsonNumber(context.source)
        : value
    )
  } catch {
    return { receipt: { providerRequestId: null, usage: {} }, costUsd: null }
  }
  if (!isRecord(body)) return { receipt: { providerRequestId: null, usage: {} }, costUsd: null }
  const usage = isRecord(body.usage) ? body.usage : {}
  const tokens: Record<string, number> = {}
  for (const field of RECEIPT_TOKEN_FIELDS) {
    if (Number.isSafeInteger(usage[field])) tokens[field] = usage[field] as number
  }
  const promptDetails = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {}
  const completionDetails = isRecord(usage.completion_tokens_details) ? usage.completion_tokens_details : {}
  if (Number.isSafeInteger(promptDetails.cached_tokens)) tokens.cached_tokens = promptDetails.cached_tokens as number
  if (Number.isSafeInteger(promptDetails.cache_write_tokens)) {
    tokens.cache_write_tokens = promptDetails.cache_write_tokens as number
  }
  if (Number.isSafeInteger(completionDetails.reasoning_tokens)) {
    tokens.reasoning_tokens = completionDetails.reasoning_tokens as number
  }
  let costUsd: string | null = null
  // BYOK `cost` is only OpenRouter's fee, not the inference charge.
  if (usage.cost instanceof RawJsonNumber && usage.is_byok !== true) {
    try {
      costUsd = ceilUsd(usage.cost.source)
    } catch {
      costUsd = null
    }
  }
  // Every bounded route bills a non-zero rate, so zero against billed tokens is not a charge to trust.
  if (costUsd === "0" && Object.values(tokens).some((count) => count > 0)) costUsd = null
  return {
    receipt: { providerRequestId: typeof body.id === "string" ? body.id : null, usage: tokens },
    costUsd,
  }
}

/**
 * Legacy egress for an explicitly unprotected workspace: before every physical
 * request (each SDK retry and embedding batch) the policy is read again, and a
 * workspace no longer unprotected sends nothing. A policy change that commits
 * after this read but before the bytes leave still lets that one request out.
 */
export function createLegacyFetch(params: {
  gate: SpendingGate
  workspaceId: string
  baseFetch: FetchLike
}): FetchLike {
  const { gate, workspaceId, baseFetch } = params
  return async (input, init) => {
    const policy = await gate.policyMode(workspaceId)
    if (policy?.mode !== "unprotected") {
      throw new SpendingDeniedError("POLICY_CHANGED", { workspaceId, mode: policy?.mode })
    }
    init?.signal?.throwIfAborted()
    // Following a 307/308 re-sends the body to a URL this check never saw.
    return baseFetch(input, { ...init, redirect: "error" })
  }
}

interface GuardedFetchParams {
  functionId: string
  gate: SpendingGate
  context: SpendingRequest
  profile: SpendingRouteProfile
  quote: SpendingQuote
  baseFetch: FetchLike
  /** Fired once per attempt immediately before egress, after dispatch is pinned. */
  onDispatch?: () => void
  /** Receives every attempt that reached the ledger past reservation. */
  onOutcome: (outcome: SpendingAttemptOutcome) => void
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input
  return input instanceof URL ? input.href : input.url
}

/**
 * At most one physical provider request per logical request. The idempotency
 * key comes from the operation and request key, so every worker, retry or
 * replay of the same step reserves the same ledger attempt and the dispatch
 * CAS lets exactly one of them send. Anyone who finds the attempt already
 * moved on gets `SpendingDuplicateRequestError` and sends nothing. Nothing
 * after a successful reserve refunds uncertainty: only a dispatch refusal
 * releases, only by the caller whose reserve created the attempt, and every
 * other failure holds the commitment.
 */
export function createGuardedFetch(params: GuardedFetchParams): FetchLike {
  const { gate, profile, quote, baseFetch, onOutcome } = params
  const context = assertSpendingRequest(params.context, "createGuardedFetch")
  const { workspaceId } = context
  const idempotencyKey = spendingIdempotencyKey(context.operationId, context.requestKey)
  const { stage } = aiSpendingPurpose(context.purpose)!
  return async (input, init) => {
    const url = requestUrl(input)
    if (url !== OPENROUTER_CHAT_COMPLETIONS_URL || init?.method !== "POST" || typeof init.body !== "string") {
      throw new SpendingDeniedError("UNSUPPORTED_OPERATION", { url, method: init?.method })
    }
    let body: unknown
    try {
      body = JSON.parse(init.body)
    } catch {
      deny("body", { reason: "not JSON" })
    }
    validateWireBody(body, profile, quote)
    init.signal?.throwIfAborted()

    const request: AISpendingAttemptRequest = {
      workspaceId,
      idempotencyKey,
      sponsorUserId: context.userId,
      sessionId: context.sessionId,
      operationId: context.operationId,
      purpose: context.purpose,
      stage,
      model: quote.model,
      providerRoute: quote.providerRoute,
      provider: "openrouter",
      functionId: params.functionId,
      maxCostUsd: quote.maxCostUsd,
    }
    const reserved = await gate.reserve(request)
    if (!reserved.allowed) {
      const { allowed: _allowed, reason, ...details } = reserved
      throw new SpendingDeniedError(reason, { ...details, maxCostUsd: quote.maxCostUsd })
    }
    const attemptId = reserved.attempt.id
    // A reserved attempt nobody dispatched yet (a racing worker, or a crashed one) is still safe to send once.
    if (!reserved.created && reserved.attempt.state !== "reserved") {
      throw new SpendingDuplicateRequestError(attemptId, reserved.attempt.state)
    }
    const hold = async (reason: SpendingHoldReason, providerRequestSent: boolean, receipt?: AISpendingReceipt) => {
      logger.warn({ attemptId, workspaceId, reason }, "AI spending attempt outcome unknown; commitment retained")
      onOutcome({ attemptId, status: "held", reason, providerRequestSent })
      try {
        await gate.markUnknown(workspaceId, attemptId, receipt)
      } catch (error) {
        logger.error({ error, attemptId, workspaceId }, "Failed to mark AI spending attempt unknown")
      }
    }

    let dispatched: SpendingDispatchOutcome
    try {
      dispatched = await gate.dispatch(workspaceId, attemptId, context.executionGeneration)
    } catch (error) {
      // The dispatch may have committed before the failure surfaced; releasing could refund a live attempt.
      await hold("dispatch_failed", false)
      throw error
    }
    if (!dispatched.dispatched) {
      if (dispatched.reason === "NOT_RESERVED") throw new SpendingDuplicateRequestError(attemptId, dispatched.state)
      // The replacement generation may be using this reservation; a stale creator never releases it.
      if (dispatched.reason === "EXECUTION_LOST") throw new SpendingExecutionLostError(attemptId)
      // A duplicate never releases: the attempt's commitment belongs to the caller that created it.
      if (reserved.created) {
        try {
          await gate.release(workspaceId, attemptId, context.executionGeneration)
        } catch (error) {
          logger.error({ error, attemptId, workspaceId }, "Failed to release undispatched AI spending attempt")
        }
      }
      const { dispatched: _dispatched, reason, ...details } = dispatched
      throw new SpendingDeniedError(reason, { ...details, attemptId, maxCostUsd: quote.maxCostUsd })
    }

    params.onDispatch?.()
    let response: Response
    try {
      // Following a 307/308 re-sends the paid body to an unchecked URL under this one reservation.
      response = await baseFetch(input, { ...init, redirect: "error" })
    } catch (error) {
      await hold("provider_request_failed", true)
      throw error
    }

    let text: string
    try {
      text = await response.clone().text()
    } catch (error) {
      await hold("response_unreadable", true)
      throw error
    }
    const { receipt, costUsd } = parseReceipt(text)
    if (costUsd === null) {
      await hold("cost_unavailable", true, receipt)
      return response
    }
    try {
      await gate.settle({ workspaceId, attemptId, actualCostUsd: costUsd, receipt })
    } catch (error) {
      logger.error({ error, attemptId, workspaceId }, "AI spending settlement failed")
      await hold("settlement_failed", true, { ...receipt, reportedCostUsd: costUsd })
      return response
    }
    onOutcome({ attemptId, status: "settled" })
    return response
  }
}
