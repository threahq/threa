/**
 * Stable paid-request identity end to end: the installed AI SDK and
 * `createAI` over the real `createSpendingGate` and ledger (INV-68), with a
 * fake provider only at the physical fetch. Two AI instances stand in for two
 * workers; the ledger's unique key and dispatch CAS must let one request out.
 * `assistant_turn` is session-bound, so every workspace gets a real running
 * session claimed through the session repository, and every request carries
 * that claim's generation.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { z } from "zod"
import type { PoolClient } from "pg"
import { AI_SPENDING_COVERAGE, AgentStepTypes, AgentToolNames, type AISpendingLimits } from "@threahq/types"
import {
  InProcessTurnDriver,
  SpendingDeniedError,
  SpendingDuplicateRequestError,
  SpendingExecutionLostError,
  SpendingResultUnavailableError,
  TurnDeliveries,
  createAI,
  defineAgentTool,
  type SpendingContext,
  type SpendingGate,
  type SpendingRequest,
  type SpendingRouteProfile,
} from "@threahq/agent-runtime"
import {
  AISpendingService,
  SpendAttemptConflictError,
  SpendPolicyRepository,
  createSpendingGate,
} from "../../src/features/ai-usage"
import { AgentSessionRepository, type CompanionExecutionRef } from "../../src/features/agents"
import { ORPHAN_SESSION_STALE_SECONDS } from "../../src/features/agents/orphan-session-cleanup"
import { StreamRepository } from "../../src/features/streams"
import { messageId, sessionId, streamId, userId, workspaceId } from "../../src/lib/id"
import { setupIsolatedTestDatabase } from "./setup"

let pool: Pool
let cleanup: () => Promise<void>
let now = new Date("2026-09-16T10:00:00Z")
let service: AISpendingService

const OPERATOR = "workos_user_operator"
const MODEL = "openrouter:openai/gpt-5.6-luna"
const OTHER_MODEL = "openrouter:openai/gpt-5.6-mini"

/** Test fixture envelope; its bound at 100 completion tokens is exactly 0.0012 USD. */
const PROFILE: SpendingRouteProfile = {
  supportedParameters: AI_SPENDING_COVERAGE.route.supportedParameters,
  model: "openai/gpt-5.6-luna",
  providerSlug: "openai",
  maxPromptTokens: 1000,
  maxCompletionTokens: 100,
  promptUsdPerToken: "0.000001",
  completionUsdPerToken: "0.000002",
  requestUsd: "0",
}
const OTHER_PROFILE: SpendingRouteProfile = { ...PROFILE, model: "openai/gpt-5.6-mini" }
const BOUND_USD = "0.0012"
const SPONSOR = "usr_sponsor"
const sessions = new Map<string, CompanionExecutionRef>()

beforeAll(async () => {
  const db = await setupIsolatedTestDatabase("ai-spend-request-identity")
  pool = db.pool
  cleanup = db.cleanup
  service = new AISpendingService({ pool, now: () => now })
})

afterAll(async () => {
  await cleanup()
})

const WIDE: AISpendingLimits = {
  agentCutoffUsd: "5",
  enrichmentCutoffUsd: "5",
  coreCutoffUsd: "5",
  embeddingCutoffUsd: "5",
  operatorCeilingUsd: "5",
}

async function seedEnforcedWorkspace(): Promise<string> {
  const id = workspaceId()
  await pool.query("INSERT INTO workspaces (id, name, slug, created_by) VALUES ($1, $2, $3, $4)", [
    id,
    "Spend",
    `spend-${id.slice(-8).toLowerCase()}`,
    userId(),
  ])
  await SpendPolicyRepository.insertUnprotected(pool, [id])
  await setLimits(id, WIDE)
  sessions.set(id, await claimSession(id))
  return id
}

/** A running companion session for the sponsor, inserted by the same repository call a turn's setup uses. */
async function claimSession(workspace: string): Promise<CompanionExecutionRef> {
  const stream = streamId()
  await StreamRepository.insert(pool, {
    id: stream,
    workspaceId: workspace,
    type: "channel",
    visibility: "private",
    companionMode: "off",
    createdBy: SPONSOR,
  })
  const session = await AgentSessionRepository.insertRunningOrSkip(pool, {
    id: sessionId(),
    streamId: stream,
    personaId: "persona_spend",
    triggerMessageId: messageId(),
    serverId: "server_gen1",
    initialSequence: 0n,
    initiatingUserId: SPONSOR,
  })
  return { sessionId: session!.id, generation: session!.executionGeneration }
}

/** Orphan-style takeover: fail the held generation and claim the next one, left uncommitted on `client`. */
async function beginTakeover(client: PoolClient, held: CompanionExecutionRef): Promise<CompanionExecutionRef> {
  await client.query("BEGIN")
  await AgentSessionRepository.failExecution(client, held.sessionId, { generation: held.generation, error: "stale" })
  const claimed = await AgentSessionRepository.claimExecution(client, held.sessionId, {
    serverId: "server_gen2",
    staleThresholdSeconds: ORPHAN_SESSION_STALE_SECONDS,
  })
  return { sessionId: held.sessionId, generation: claimed!.executionGeneration }
}

async function takeOver(held: CompanionExecutionRef): Promise<CompanionExecutionRef> {
  const client = await pool.connect()
  try {
    const next = await beginTakeover(client, held)
    await client.query("COMMIT")
    return next
  } finally {
    client.release()
  }
}

async function waitForLockWait(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const waiting = await pool.query(
      "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'"
    )
    if ((waiting.rowCount ?? 0) > 0) return
    await Bun.sleep(10)
  }
  throw new Error("dispatch never waited on the session lock")
}

async function setLimits(workspace: string, limits: AISpendingLimits): Promise<void> {
  const policy = await service.getPolicy(workspace)
  await service.setPolicy({
    workspaceId: workspace,
    expectedVersion: policy!.version,
    operatorWorkosUserId: OPERATOR,
    status: "enforced",
    coverageProfile: AI_SPENDING_COVERAGE.profile,
    limits,
  })
}

function limitsAt(amount: string): AISpendingLimits {
  return {
    agentCutoffUsd: amount,
    enrichmentCutoffUsd: amount,
    coreCutoffUsd: amount,
    embeddingCutoffUsd: amount,
    operatorCeilingUsd: amount,
  }
}

function root(workspace: string, overrides: Partial<SpendingContext> = {}): SpendingContext {
  const session = sessions.get(workspace)!
  return {
    workspaceId: workspace,
    userId: SPONSOR,
    sessionId: session.sessionId,
    executionGeneration: session.generation,
    operationId: "op_turn_1",
    purpose: "assistant_turn",
    ...overrides,
  }
}

function step(workspace: string, requestKey = "step_0", overrides: Partial<SpendingContext> = {}): SpendingRequest {
  return { ...root(workspace, overrides), requestKey }
}

interface Provider {
  requests: Array<Record<string, unknown>>
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
}

type Reply = (body: Record<string, unknown>, index: number) => Record<string, unknown>

function textReply(cost: number | null = 0.0005): Reply {
  return () => ({
    id: "gen-1",
    model: PROFILE.model,
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, ...(cost === null ? {} : { cost }) },
  })
}

function fakeProvider(reply: Reply = textReply(), beforeReply?: () => Promise<void>): Provider {
  const requests: Array<Record<string, unknown>> = []
  return {
    requests,
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      requests.push(body)
      await beforeReply?.()
      return new Response(JSON.stringify(reply(body, requests.length - 1)), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    },
  }
}

function gate(): SpendingGate {
  return createSpendingGate({ spendingService: service, routes: [PROFILE, OTHER_PROFILE] })
}

function worker(provider: Provider, spendingGate: SpendingGate = gate()) {
  return createAI({ openrouter: { apiKey: "test-key", fetch: provider.fetch }, spendingGate })
}

/** Resolves every waiter only once `parties` callers are waiting. */
function barrier(parties: number): () => Promise<void> {
  const waiting: Array<() => void> = []
  return () =>
    new Promise<void>((resolve) => {
      waiting.push(resolve)
      if (waiting.length === parties) for (const release of waiting) release()
    })
}

async function attempts(workspace: string) {
  const result = await pool.query<{
    idempotency_key: string
    operation_id: string
    sponsor_user_id: string
    purpose: string
    stage: string
    model: string
    max_cost_usd: string
    state: string
    actual_cost_usd: string | null
  }>(
    `SELECT idempotency_key, operation_id, sponsor_user_id, purpose, stage, model, max_cost_usd::text,
            state, actual_cost_usd::text
     FROM ai_spending_attempts WHERE workspace_id = $1 ORDER BY created_at, idempotency_key`,
    [workspace]
  )
  return result.rows
}

async function totals(workspace: string) {
  return (await service.listPeriods(workspace)).map((p) => ({ settledUsd: p.settledUsd, committedUsd: p.committedUsd }))
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error("expected a rejection")
}

const messages = [{ role: "user" as const, content: "hi" }]

describe("authoritative usage projection", () => {
  test("should record a paid receipt before SDK validation and never double-project it", async () => {
    const workspace = await seedEnforcedWorkspace()
    const provider = fakeProvider((body, index) => ({ ...textReply()(body, index), choices: [] }))
    let legacyWrites = 0
    const ai = createAI({
      openrouter: { apiKey: "test", fetch: provider.fetch },
      spendingGate: gate(),
      costRecorder: {
        recordUsage: async () => {
          legacyWrites++
        },
      },
    })
    await expect(
      ai.generateText({
        model: MODEL,
        messages,
        spending: step(workspace),
        telemetry: { functionId: "accounting-proof" },
      })
    ).rejects.toBeInstanceOf(SpendingResultUnavailableError)
    const stored = await pool.query(
      "SELECT id, actual_cost_usd, receipt FROM ai_spending_attempts WHERE workspace_id=$1",
      [workspace]
    )
    const attempt = stored.rows[0]
    await service.settle({
      workspaceId: workspace,
      attemptId: attempt.id,
      actualCostUsd: attempt.actual_cost_usd,
      receipt: attempt.receipt,
    })
    const usage = await pool.query(
      "SELECT function_id, provider, model, user_id, cost_usd::text, created_at FROM ai_usage_records WHERE workspace_id=$1",
      [workspace]
    )
    expect({ usage: usage.rows, physical: provider.requests.length, legacyWrites }).toEqual({
      usage: [
        {
          function_id: "accounting-proof",
          provider: "openrouter",
          model: PROFILE.model,
          user_id: SPONSOR,
          cost_usd: "0.00050000",
          created_at: now,
        },
      ],
      physical: 1,
      legacyWrites: 0,
    })
  })

  test("should retain missing-cost receipt metadata without recording a free call", async () => {
    const workspace = await seedEnforcedWorkspace()
    const provider = fakeProvider(textReply(null))
    await worker(provider).generateText({ model: MODEL, messages, spending: step(workspace) })
    const stored = await pool.query(
      "SELECT state, actual_cost_usd, receipt FROM ai_spending_attempts WHERE workspace_id=$1",
      [workspace]
    )
    const usage = await pool.query("SELECT id FROM ai_usage_records WHERE workspace_id=$1", [workspace])
    expect({ attempts: stored.rows, usage: usage.rows, totals: await totals(workspace) }).toEqual({
      attempts: [
        {
          state: "unknown",
          actual_cost_usd: null,
          receipt: { providerRequestId: "gen-1", usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
        },
      ],
      usage: [],
      totals: [{ settledUsd: "0", committedUsd: BOUND_USD }],
    })
  })

  test("should roll back accounting on projection failure and reconcile the saved receipt without another inference", async () => {
    const workspace = await seedEnforcedWorkspace()
    await pool.query(
      `CREATE FUNCTION reject_spending_projection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'projection unavailable'; END $$`
    )
    await pool.query(
      "CREATE TRIGGER reject_spending_projection BEFORE INSERT ON ai_usage_records FOR EACH ROW EXECUTE FUNCTION reject_spending_projection()"
    )
    const provider = fakeProvider()
    try {
      await worker(provider).generateText({ model: MODEL, messages, spending: step(workspace) })
      const stored = await pool.query(
        "SELECT state, actual_cost_usd, receipt FROM ai_spending_attempts WHERE workspace_id=$1",
        [workspace]
      )
      expect(stored.rows).toEqual([
        {
          state: "unknown",
          actual_cost_usd: null,
          receipt: {
            providerRequestId: "gen-1",
            reportedCostUsd: "0.0005",
            usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
          },
        },
      ])
      expect(await totals(workspace)).toEqual([{ settledUsd: "0", committedUsd: BOUND_USD }])
    } finally {
      await pool.query("DROP TRIGGER reject_spending_projection ON ai_usage_records")
      await pool.query("DROP FUNCTION reject_spending_projection()")
    }
    const stored = await pool.query("SELECT id, receipt FROM ai_spending_attempts WHERE workspace_id=$1", [workspace])
    const attempt = stored.rows[0]
    await service.settle({
      workspaceId: workspace,
      attemptId: attempt.id,
      actualCostUsd: attempt.receipt.reportedCostUsd,
      receipt: attempt.receipt,
    })
    const usage = await pool.query("SELECT cost_usd::text FROM ai_usage_records WHERE workspace_id=$1", [workspace])
    expect({ usage: usage.rows, physical: provider.requests.length, totals: await totals(workspace) }).toEqual({
      usage: [{ cost_usd: "0.00050000" }],
      physical: 1,
      totals: [{ settledUsd: "0.0005", committedUsd: "0" }],
    })
  })

  test("should attribute a late settlement's usage to its authorization period", async () => {
    const workspace = await seedEnforcedWorkspace()
    const authorizedAt = new Date("2026-09-30T23:59:00Z")
    now = authorizedAt
    try {
      const provider = fakeProvider(textReply(), async () => {
        now = new Date("2026-10-01T00:01:00Z")
      })
      await worker(provider).generateText({ model: MODEL, messages, spending: step(workspace) })
      const usage = await pool.query("SELECT created_at FROM ai_usage_records WHERE workspace_id=$1", [workspace])
      expect(usage.rows).toEqual([{ created_at: authorizedAt }])
      expect((await service.listPeriods(workspace))[0]?.endsAt).toEqual(new Date("2026-10-01T00:00:00Z"))
    } finally {
      now = new Date("2026-09-16T10:00:00Z")
    }
  })
})

describe("one logical request, one physical inference", () => {
  test("two workers racing the same operation step send exactly one request and settle one attempt", async () => {
    const workspace = await seedEnforcedWorkspace()
    const loserObserved = Promise.withResolvers<void>()
    const provider = fakeProvider(textReply(), () => loserObserved.promise)
    const reserveTogether = barrier(2)
    const dispatchTogether = barrier(2)
    const synchronized = (): SpendingGate => {
      const inner = gate()
      return {
        ...inner,
        reserve: async (request) => {
          await reserveTogether()
          return inner.reserve(request)
        },
        dispatch: async (ws, attemptId, generation) => {
          await dispatchTogether()
          return inner.dispatch(ws, attemptId, generation)
        },
      }
    }
    const run = () =>
      worker(provider, synchronized())
        .generateText({ model: MODEL, messages, spending: step(workspace) })
        .catch((error) => {
          loserObserved.resolve()
          throw error
        })
    const results = await Promise.allSettled([run(), run()])

    const won = results.filter((r) => r.status === "fulfilled")
    const lost = results.flatMap((r) => (r.status === "rejected" ? [r.reason] : []))
    expect(lost[0]).toBeInstanceOf(SpendingDuplicateRequestError)
    expect({
      won: won.length,
      lostState: (lost[0] as SpendingDuplicateRequestError).state,
      physical: provider.requests.length,
      attempts: await attempts(workspace),
      totals: await totals(workspace),
    }).toEqual({
      won: 1,
      lostState: "dispatched",
      physical: 1,
      attempts: [
        {
          idempotency_key: "op:9:op_turn_1:req:step_0",
          operation_id: "op_turn_1",
          sponsor_user_id: "usr_sponsor",
          purpose: "assistant_turn",
          stage: "agent",
          model: PROFILE.model,
          max_cost_usd: "0.00120000",
          state: "settled",
          actual_cost_usd: "0.00050000",
        },
      ],
      totals: [{ settledUsd: "0.0005", committedUsd: "0" }],
    })
  })

  test("replaying a settled or unknown step sends nothing; other steps and operations reserve their own attempt", async () => {
    const workspace = await seedEnforcedWorkspace()
    const provider = fakeProvider(textReply())
    await worker(provider).generateText({ model: MODEL, messages, spending: step(workspace, "step_0") })

    const noCost = fakeProvider(textReply(null))
    const held = await worker(noCost).generateText({ model: MODEL, messages, spending: step(workspace, "step_1") })
    expect(held.spendingAttempts).toEqual([
      { attemptId: expect.any(String), status: "held", reason: "cost_unavailable", providerRequestSent: true },
    ])

    const replay = fakeProvider()
    const settledReplay = await rejection(
      worker(replay).generateText({ model: MODEL, messages, spending: step(workspace, "step_0") })
    )
    const unknownReplay = await rejection(
      worker(replay).generateText({ model: MODEL, messages, spending: step(workspace, "step_1") })
    )
    expect([settledReplay, unknownReplay].map((e) => (e as SpendingDuplicateRequestError).state)).toEqual([
      "settled",
      "unknown",
    ])
    expect(replay.requests).toEqual([])

    const fresh = fakeProvider()
    await worker(fresh).generateText({ model: MODEL, messages, spending: step(workspace, "step_2") })
    await worker(fresh).generateText({
      model: MODEL,
      messages,
      spending: step(workspace, "step_0", { operationId: "op_turn_2" }),
    })
    expect({
      physical: fresh.requests.length,
      rows: (await attempts(workspace)).map((a) => [a.idempotency_key, a.state]),
      totals: await totals(workspace),
    }).toEqual({
      physical: 2,
      rows: [
        ["op:9:op_turn_1:req:step_0", "settled"],
        ["op:9:op_turn_1:req:step_1", "unknown"],
        ["op:9:op_turn_1:req:step_2", "settled"],
        ["op:9:op_turn_2:req:step_0", "settled"],
      ],
      totals: [{ settledUsd: "0.0015", committedUsd: "0.0012" }],
    })
  })

  test("the same key with a changed sponsor, model, purpose or bound refuses identity reuse before egress", async () => {
    const workspace = await seedEnforcedWorkspace()
    await worker(fakeProvider()).generateText({ model: MODEL, messages, maxTokens: 50, spending: step(workspace) })

    const provider = fakeProvider()
    const sponsor = await rejection(
      worker(provider).generateText({
        model: MODEL,
        messages,
        maxTokens: 50,
        spending: step(workspace, "step_0", { userId: "usr_other" }),
      })
    )
    const model = await rejection(
      worker(provider).generateText({ model: OTHER_MODEL, messages, maxTokens: 50, spending: step(workspace) })
    )
    const bound = await rejection(
      worker(provider).generateText({ model: MODEL, messages, maxTokens: 60, spending: step(workspace) })
    )
    const [existing] = await attempts(workspace)
    // The catalog holds one purpose, so a changed purpose can only reach the ledger directly.
    const purpose = await rejection(
      service.reserve({
        workspaceId: workspace,
        idempotencyKey: existing!.idempotency_key,
        sponsorUserId: "usr_sponsor",
        sessionId: "session_1",
        operationId: "op_turn_1",
        purpose: "historical_purpose",
        stage: "agent",
        model: PROFILE.model,
        providerRoute: PROFILE.providerSlug,
        provider: "openrouter",
        functionId: "generateText",
        maxCostUsd: existing!.max_cost_usd,
      })
    )
    expect({
      conflicts: [sponsor, model, bound, purpose].map((e) => e instanceof SpendAttemptConflictError),
      physical: provider.requests.length,
      rows: (await attempts(workspace)).map((a) => [a.idempotency_key, a.state, a.max_cost_usd]),
    }).toEqual({
      conflicts: [true, true, true, true],
      physical: 0,
      rows: [["op:9:op_turn_1:req:step_0", "settled", "0.00110000"]],
    })
  })
})

describe("purpose decides the stage", () => {
  test("a forged caller stage is ignored, and a gate request whose stage disagrees with its purpose is refused", async () => {
    const workspace = await seedEnforcedWorkspace()
    const provider = fakeProvider()
    const forged = { ...step(workspace), stage: "embedding" } as SpendingRequest
    await worker(provider).generateText({ model: MODEL, messages, spending: forged })

    const direct = await rejection(
      gate().reserve({
        workspaceId: workspace,
        idempotencyKey: "op:9:op_turn_1:req:forged",
        sponsorUserId: "usr_sponsor",
        sessionId: "session_1",
        operationId: "op_turn_1",
        purpose: "assistant_turn",
        stage: "embedding",
        model: PROFILE.model,
        providerRoute: PROFILE.providerSlug,
        provider: "openrouter",
        functionId: "generateText",
        maxCostUsd: BOUND_USD,
      })
    )
    expect({
      stages: (await attempts(workspace)).map((a) => [a.purpose, a.stage]),
      direct: direct instanceof SpendingDeniedError ? direct.code : direct,
      physical: provider.requests.length,
    }).toEqual({ stages: [["assistant_turn", "agent"]], direct: "MISSING_CONTEXT", physical: 1 })
  })

  test("route profiles are fixed when the gate is built", async () => {
    const workspace = await seedEnforcedWorkspace()
    const profile = { ...PROFILE }
    const spendingGate = createSpendingGate({ spendingService: service, routes: [profile] })
    profile.completionUsdPerToken = "0.00000001"
    profile.providerSlug = "cheap"
    expect(await spendingGate.routeFor({ context: root(workspace), modelId: PROFILE.model })).toEqual(PROFILE)
  })

  test("an unknown purpose or a missing request key fails before the ledger or the provider", async () => {
    const workspace = await seedEnforcedWorkspace()
    const provider = fakeProvider()
    const unknown = await rejection(
      worker(provider).generateText({
        model: MODEL,
        messages,
        spending: { ...step(workspace), purpose: "cheap_infrastructure" } as unknown as SpendingRequest,
      })
    )
    const { requestKey: _dropped, ...keyless } = step(workspace)
    const missingKey = await rejection(
      worker(provider).generateText({ model: MODEL, messages, spending: keyless as SpendingRequest })
    )
    expect({
      errors: [unknown, missingKey].map((e) => ({
        code: (e as SpendingDeniedError).code,
        fields: (e as SpendingDeniedError).details.fields,
      })),
      physical: provider.requests.length,
      rows: await attempts(workspace),
      periods: await totals(workspace),
    }).toEqual({
      errors: [
        { code: "MISSING_CONTEXT", fields: ["purpose"] },
        { code: "MISSING_CONTEXT", fields: ["requestKey"] },
      ],
      physical: 0,
      rows: [],
      periods: [],
    })
  })
})

describe("a policy changed between reserve and dispatch", () => {
  function lowering(afterReserve: () => Promise<void>): SpendingGate {
    const inner = gate()
    return {
      ...inner,
      reserve: async (request) => {
        const outcome = await inner.reserve(request)
        await afterReserve()
        return outcome
      },
    }
  }

  test("limits lowered to zero stop the attempt with no provider request, release only its own bound, and latch nothing", async () => {
    const workspace = await seedEnforcedWorkspace()
    await worker(fakeProvider()).generateText({ model: MODEL, messages, spending: step(workspace, "paid") })
    const provider = fakeProvider()
    const error = await rejection(
      worker(
        provider,
        lowering(() => setLimits(workspace, limitsAt("0")))
      ).generateText({
        model: MODEL,
        messages,
        spending: step(workspace, "lowered"),
      })
    )
    expect({
      code: (error as SpendingDeniedError).code,
      details: (error as SpendingDeniedError).details,
      physical: provider.requests.length,
      rows: (await attempts(workspace)).map((a) => [a.idempotency_key, a.state]),
      totals: await totals(workspace),
      latched: (await service.getPolicy(workspace))!.emergencyLatched,
    }).toEqual({
      code: "LIMIT_EXCEEDED",
      details: {
        stage: "agent",
        cutoffUsd: "0",
        settledUsd: "0.0005",
        committedUsd: BOUND_USD,
        attemptId: expect.any(String),
        maxCostUsd: BOUND_USD,
      },
      physical: 0,
      rows: [
        ["op:9:op_turn_1:req:lowered", "released"],
        ["op:9:op_turn_1:req:paid", "settled"],
      ],
      totals: [{ settledUsd: "0.0005", committedUsd: "0" }],
      latched: false,
    })
  })

  test("a lowered limit that still fits settled plus commitments dispatches, one unit less does not", async () => {
    const workspace = await seedEnforcedWorkspace()
    await worker(fakeProvider()).generateText({ model: MODEL, messages, spending: step(workspace, "paid") })
    // settled 0.0005 + this attempt's committed 0.0012, counted once.
    const exact = fakeProvider()
    await worker(
      exact,
      lowering(() => setLimits(workspace, limitsAt("0.0017")))
    ).generateText({
      model: MODEL,
      messages,
      spending: step(workspace, "fits"),
    })
    await setLimits(workspace, WIDE)

    const short = fakeProvider()
    const error = await rejection(
      worker(
        short,
        lowering(() => setLimits(workspace, limitsAt("0.00219999")))
      ).generateText({
        model: MODEL,
        messages,
        spending: step(workspace, "short"),
      })
    )
    expect({
      exactPhysical: exact.requests.length,
      shortPhysical: short.requests.length,
      shortCode: (error as SpendingDeniedError).code,
      rows: (await attempts(workspace)).map((a) => [a.idempotency_key, a.state]),
      totals: await totals(workspace),
    }).toEqual({
      exactPhysical: 1,
      shortPhysical: 0,
      shortCode: "LIMIT_EXCEEDED",
      rows: [
        ["op:9:op_turn_1:req:fits", "settled"],
        ["op:9:op_turn_1:req:paid", "settled"],
        ["op:9:op_turn_1:req:short", "released"],
      ],
      totals: [{ settledUsd: "0.001", committedUsd: "0" }],
    })
  })

  test("dispatch checks the attempt's pinned period, not the period now falls in", async () => {
    const workspace = await seedEnforcedWorkspace()
    now = new Date("2026-09-16T10:00:00Z")
    await worker(fakeProvider()).generateText({ model: MODEL, messages, spending: step(workspace, "paid") })
    const provider = fakeProvider()
    const error = await rejection(
      worker(
        provider,
        lowering(async () => {
          now = new Date("2026-10-16T10:00:00Z")
          await setLimits(workspace, limitsAt("0.0016"))
        })
      ).generateText({ model: MODEL, messages, spending: step(workspace, "late") })
    )
    now = new Date("2026-09-16T10:00:00Z")
    expect({
      code: (error as SpendingDeniedError).code,
      physical: provider.requests.length,
      periods: await totals(workspace),
    }).toEqual({ code: "LIMIT_EXCEEDED", physical: 0, periods: [{ settledUsd: "0.0005", committedUsd: "0" }] })
  })

  test("a limit lowered after dispatch cannot refund the attempt: it settles in full without a latch", async () => {
    const workspace = await seedEnforcedWorkspace()
    const provider = fakeProvider(textReply(0.001), () => setLimits(workspace, limitsAt("0")))
    await worker(provider).generateText({ model: MODEL, messages, spending: step(workspace, "in_flight") })
    expect({
      physical: provider.requests.length,
      rows: (await attempts(workspace)).map((a) => [a.state, a.actual_cost_usd]),
      totals: await totals(workspace),
      latched: (await service.getPolicy(workspace))!.emergencyLatched,
    }).toEqual({
      physical: 1,
      rows: [["settled", "0.00100000"]],
      totals: [{ settledUsd: "0.001", committedUsd: "0" }],
      latched: false,
    })
  })

  test("a creator's release that loses to another worker's dispatch refunds nothing", async () => {
    const workspace = await seedEnforcedWorkspace()
    await setLimits(workspace, limitsAt("0"))
    const winner = fakeProvider()
    let winnerResult: unknown
    const inner = gate()
    const creatorGate: SpendingGate = {
      ...inner,
      reserve: async (request) => {
        await setLimits(workspace, WIDE)
        const outcome = await inner.reserve(request)
        await setLimits(workspace, limitsAt("0"))
        return outcome
      },
      release: async (ws, attemptId, generation) => {
        await setLimits(workspace, WIDE)
        winnerResult = await worker(winner).generateText({ model: MODEL, messages, spending: step(workspace) })
        const released = await inner.release(ws, attemptId, generation)
        expect(released).toBe(false)
        return released
      },
    }
    const creator = fakeProvider()
    const error = await rejection(
      worker(creator, creatorGate).generateText({ model: MODEL, messages, spending: step(workspace) })
    )
    expect({
      creatorCode: (error as SpendingDeniedError).code,
      creatorPhysical: creator.requests.length,
      winnerPhysical: winner.requests.length,
      winnerSettled: (winnerResult as { spendingAttempts?: unknown }).spendingAttempts,
      rows: (await attempts(workspace)).map((a) => [a.idempotency_key, a.state, a.actual_cost_usd]),
      totals: await totals(workspace),
    }).toEqual({
      creatorCode: "LIMIT_EXCEEDED",
      creatorPhysical: 0,
      winnerPhysical: 1,
      winnerSettled: [{ attemptId: expect.any(String), status: "settled" }],
      rows: [["op:9:op_turn_1:req:step_0", "settled", "0.00050000"]],
      totals: [{ settledUsd: "0.0005", committedUsd: "0" }],
    })
  })
})

describe("recovering a step after a crash", () => {
  /** The exact attempt the runtime reserves for `step(workspace)` at the default bound. */
  function crashedReservation(workspace: string) {
    return gate().reserve({
      workspaceId: workspace,
      idempotencyKey: "op:9:op_turn_1:req:step_0",
      sponsorUserId: SPONSOR,
      sessionId: sessions.get(workspace)!.sessionId,
      operationId: "op_turn_1",
      purpose: "assistant_turn",
      stage: "agent",
      model: PROFILE.model,
      providerRoute: PROFILE.providerSlug,
      provider: "openrouter",
      functionId: "generateText",
      maxCostUsd: BOUND_USD,
    })
  }

  test("a reservation left by a crashed worker is sent once by the replay; a refused replay keeps the bound committed", async () => {
    const workspace = await seedEnforcedWorkspace()
    expect(await crashedReservation(workspace)).toMatchObject({ allowed: true, created: true })

    await setLimits(workspace, limitsAt("0"))
    const refused = fakeProvider()
    const refusal = await rejection(worker(refused).generateText({ model: MODEL, messages, spending: step(workspace) }))
    const afterRefusal = {
      code: (refusal as SpendingDeniedError).code,
      physical: refused.requests.length,
      rows: (await attempts(workspace)).map((a) => a.state),
      totals: await totals(workspace),
    }

    await setLimits(workspace, WIDE)
    const replay = fakeProvider()
    await worker(replay).generateText({ model: MODEL, messages, spending: step(workspace) })
    const again = await rejection(worker(replay).generateText({ model: MODEL, messages, spending: step(workspace) }))

    expect({
      afterRefusal,
      againState: (again as SpendingDuplicateRequestError).state,
      physical: replay.requests.length,
      rows: (await attempts(workspace)).map((a) => [a.state, a.actual_cost_usd]),
      totals: await totals(workspace),
    }).toEqual({
      afterRefusal: {
        code: "LIMIT_EXCEEDED",
        physical: 0,
        rows: ["reserved"],
        totals: [{ settledUsd: "0", committedUsd: BOUND_USD }],
      },
      againState: "settled",
      physical: 1,
      rows: [["settled", "0.00050000"]],
      totals: [{ settledUsd: "0.0005", committedUsd: "0" }],
    })
  })

  test("a step released by a dispatch refusal stays refused after the limit is raised again", async () => {
    const workspace = await seedEnforcedWorkspace()
    const lowered: SpendingGate = {
      ...gate(),
      reserve: async (request) => {
        const outcome = await gate().reserve(request)
        await setLimits(workspace, limitsAt("0"))
        return outcome
      },
    }
    await rejection(worker(fakeProvider(), lowered).generateText({ model: MODEL, messages, spending: step(workspace) }))
    await setLimits(workspace, WIDE)
    const replay = fakeProvider()
    const error = await rejection(worker(replay).generateText({ model: MODEL, messages, spending: step(workspace) }))
    expect({
      state: (error as SpendingDuplicateRequestError).state,
      physical: replay.requests.length,
      rows: (await attempts(workspace)).map((a) => a.state),
      totals: await totals(workspace),
    }).toEqual({ state: "released", physical: 0, rows: ["released"], totals: [{ settledUsd: "0", committedUsd: "0" }] })
  })
})

describe("a replaced session execution", () => {
  test("cannot dispatch or release its reservation; the replacement sends the same logical request once", async () => {
    const workspace = await seedEnforcedWorkspace()
    const gen1 = sessions.get(workspace)!
    const stale = fakeProvider()
    const inner = gate()
    let gen2!: CompanionExecutionRef
    let staleRelease: unknown
    let afterStale: unknown
    const staleGate: SpendingGate = {
      ...inner,
      dispatch: async (ws, attemptId, generation) => {
        // The takeover holds the session row while the stale dispatch waits on it, then commits.
        const client = await pool.connect()
        try {
          gen2 = await beginTakeover(client, gen1)
          const pending = inner.dispatch(ws, attemptId, generation)
          await waitForLockWait()
          await client.query("COMMIT")
          const outcome = await pending
          staleRelease = await inner.release(ws, attemptId, generation)
          afterStale = {
            rows: (await attempts(workspace)).map((a) => a.state),
            totals: await totals(workspace),
            missingIdentity: await service.dispatch(ws, attemptId, null),
          }
          return outcome
        } finally {
          client.release()
        }
      },
    }
    const staleError = await rejection(
      worker(stale, staleGate).generateText({ model: MODEL, messages, spending: step(workspace) })
    )

    const current = fakeProvider()
    const result = await worker(current).generateText({
      model: MODEL,
      messages,
      spending: step(workspace, "step_0", { executionGeneration: gen2.generation }),
    })
    const replay = await rejection(
      worker(fakeProvider()).generateText({
        model: MODEL,
        messages,
        spending: step(workspace, "step_0", { executionGeneration: gen2.generation }),
      })
    )

    expect({
      staleLost: staleError instanceof SpendingExecutionLostError,
      staleRelease,
      afterStale,
      physical: [stale.requests.length, current.requests.length],
      generations: [gen1.generation, gen2.generation],
      settled: result.spendingAttempts,
      replayState: (replay as SpendingDuplicateRequestError).state,
      rows: (await attempts(workspace)).map((a) => [a.idempotency_key, a.state, a.actual_cost_usd]),
      totals: await totals(workspace),
    }).toEqual({
      staleLost: true,
      staleRelease: false,
      afterStale: {
        rows: ["reserved"],
        totals: [{ settledUsd: "0", committedUsd: BOUND_USD }],
        missingIdentity: { dispatched: false, reason: "EXECUTION_LOST" },
      },
      physical: [0, 1],
      generations: [1, 2],
      settled: [{ attemptId: expect.any(String), status: "settled" }],
      replayState: "settled",
      rows: [["op:9:op_turn_1:req:step_0", "settled", "0.00050000"]],
      totals: [{ settledUsd: "0.0005", committedUsd: "0" }],
    })
  })

  test("work it already dispatched still settles after the takeover, and a sponsor mismatch never dispatches", async () => {
    const workspace = await seedEnforcedWorkspace()
    const gen1 = sessions.get(workspace)!
    const inFlight = fakeProvider(textReply(), async () => {
      await takeOver(gen1)
    })
    const result = await worker(inFlight).generateText({ model: MODEL, messages, spending: step(workspace) })

    const other = await seedEnforcedWorkspace()
    const foreign = fakeProvider()
    const foreignError = await rejection(
      worker(foreign).generateText({
        model: MODEL,
        messages,
        spending: step(other, "step_0", { userId: "usr_not_the_sponsor" }),
      })
    )

    expect({
      settled: result.spendingAttempts,
      rows: (await attempts(workspace)).map((a) => [a.state, a.actual_cost_usd]),
      totals: await totals(workspace),
      foreign: {
        lost: foreignError instanceof SpendingExecutionLostError,
        physical: foreign.requests.length,
        rows: (await attempts(other)).map((a) => a.state),
      },
    }).toEqual({
      settled: [{ attemptId: expect.any(String), status: "settled" }],
      rows: [["settled", "0.00050000"]],
      totals: [{ settledUsd: "0.0005", committedUsd: "0" }],
      foreign: { lost: true, physical: 0, rows: ["reserved"] },
    })
  })
})

describe("the agent loop over the real ledger", () => {
  const lookup = defineAgentTool({
    name: "fixture_lookup",
    description: "Returns a fixed string; no paid or external effect.",
    categories: [],
    inputSchema: z.object({ q: z.string() }),
    execute: async () => ({ output: "fixture result" }),
    trace: { stepType: AgentStepTypes.WORKSPACE_SEARCH, formatContent: () => "{}" },
  })

  const toolRoundTrip: Reply = (_body, index) => {
    const call =
      index === 0
        ? { name: "fixture_lookup", arguments: JSON.stringify({ q: "x" }) }
        : { name: AgentToolNames.SEND_MESSAGE, arguments: JSON.stringify({ content: "done" }) }
    return {
      id: `gen-${index}`,
      model: PROFILE.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: `call_${index}`, type: "function", function: call }],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cost: 0.0001 },
    }
  }

  async function runTurn(workspace: string, provider: Provider) {
    const ai = worker(provider)
    const committed: string[] = []
    const result = await new InProcessTurnDriver({ ai }).runTurn(
      {
        delivery: TurnDeliveries.PLAINTEXT,
        model: ai.getLanguageModel(MODEL),
        modelString: MODEL,
        systemPrompt: "Use the lookup, then reply.",
        messages: [{ role: "user", content: "look it up" }],
        tools: [lookup],
        spending: root(workspace, { operationId: "op_agent_turn" }),
      },
      {
        commitMessage: async ({ content }) => {
          committed.push(content)
          return { messageId: "msg_1" }
        },
      }
    )
    return { result, committed }
  }

  test("each loop iteration is its own keyed attempt, and replaying the turn buys nothing again", async () => {
    const workspace = await seedEnforcedWorkspace()
    const provider = fakeProvider(toolRoundTrip)
    const { committed } = await runTurn(workspace, provider)

    const replay = fakeProvider(toolRoundTrip)
    const replayError = await rejection(runTurn(workspace, replay))
    expect({
      committed,
      physical: provider.requests.length,
      secondRequestHasToolResult: (provider.requests[1]?.messages as Array<{ role: string }>).some(
        (m) => m.role === "tool"
      ),
      rows: (await attempts(workspace)).map((a) => [a.idempotency_key, a.stage, a.state]),
      replay: {
        duplicate: replayError instanceof SpendingDuplicateRequestError,
        state: (replayError as SpendingDuplicateRequestError).state,
        physical: replay.requests.length,
      },
    }).toEqual({
      committed: ["done"],
      physical: 2,
      secondRequestHasToolResult: true,
      rows: [
        ["op:13:op_agent_turn:req:agent-loop:iteration:0", "agent", "settled"],
        ["op:13:op_agent_turn:req:agent-loop:iteration:1", "agent", "settled"],
      ],
      replay: { duplicate: true, state: "settled", physical: 0 },
    })
  })
})
