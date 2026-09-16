/**
 * Companion session ownership under spending: real Postgres, the real
 * `withCompanionSession`, and for spending outcomes the real turn driver over
 * `createAI` + `createSpendingGate` + the ledger, with a fake provider only at
 * the physical fetch (INV-68).
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import type { Pool } from "pg"
import { AI_SPENDING_COVERAGE, type AISpendingLimits, type AgentSessionSpendingStop } from "@threahq/types"
import {
  InProcessTurnDriver,
  SpendingDeniedError,
  SpendingDuplicateRequestError,
  SpendingOutcomeUnknownError,
  SpendingResultUnavailableError,
  TurnDeliveries,
  createAI,
  type SpendingRouteProfile,
} from "@threahq/agent-runtime"
import { AgentSessionRepository, type AgentSession } from "../../src/features/agents"
import { withCompanionSession } from "../../src/features/agents/companion"
import { failSessionWithLifecycleInTransaction } from "../../src/features/agents/orphan-session-cleanup"
import { createPersonaAgentWorker } from "../../src/features/agents/persona-agent-worker"
import { SessionAbortRegistry } from "../../src/features/agents/session-abort-registry"
import { AISpendingService, SpendPolicyRepository, createSpendingGate } from "../../src/features/ai-usage"
import { StreamEventRepository, StreamRepository } from "../../src/features/streams"
import { messageId, personaId, sessionId, streamId, userId, workspaceId } from "../../src/lib/id"
import {
  JobQueues,
  QueueManager,
  QueueRepository,
  TokenPoolRepository,
  type PersonaAgentJobData,
} from "../../src/lib/queue"
import { setupIsolatedTestDatabase, withTransaction } from "./setup"

let pool: Pool
let cleanup: () => Promise<void>
let service: AISpendingService

const MODEL = "openrouter:openai/gpt-5.6-luna"
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

beforeAll(async () => {
  const db = await setupIsolatedTestDatabase("companion-session-spending-lifecycle")
  pool = db.pool
  cleanup = db.cleanup
  service = new AISpendingService({ pool })
})

afterAll(async () => {
  await cleanup()
})

function limitsAt(amount: string): AISpendingLimits {
  return {
    agentCutoffUsd: amount,
    enrichmentCutoffUsd: amount,
    coreCutoffUsd: amount,
    embeddingCutoffUsd: amount,
    operatorCeilingUsd: amount,
  }
}

async function setLimits(workspace: string, amount: string): Promise<void> {
  const policy = await service.getPolicy(workspace)
  await service.setPolicy({
    workspaceId: workspace,
    expectedVersion: policy!.version,
    operatorWorkosUserId: "workos_user_operator",
    status: "enforced",
    coverageProfile: AI_SPENDING_COVERAGE.profile,
    limits: limitsAt(amount),
  })
}

async function seedEnforcedWorkspace(amount: string): Promise<string> {
  const id = workspaceId()
  await pool.query("INSERT INTO workspaces (id, name, slug, created_by) VALUES ($1, $2, $3, $4)", [
    id,
    "Spend",
    `spend-${id.slice(-8).toLowerCase()}`,
    userId(),
  ])
  await SpendPolicyRepository.insertUnprotected(pool, [id])
  await setLimits(id, amount)
  return id
}

interface Provider {
  requests: number
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
}

function provider(respond: () => Promise<Response>): Provider {
  const p: Provider = {
    requests: 0,
    fetch: async () => {
      p.requests++
      return respond()
    },
  }
  return p
}

const replyOk = () =>
  Promise.resolve(
    new Response(
      JSON.stringify({
        id: "gen-1",
        model: PROFILE.model,
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cost: 0.0001 },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    )
  )

/** The paid turn a host runs for a claimed session: funded by the row's sponsor and operation, never the job's. */
function paidWork(workspace: string, transport: Provider) {
  return async (session: AgentSession) => {
    // The ledger scopes the session to the workspace through its stream.
    if (!(await StreamRepository.findById(pool, session.streamId))) {
      await StreamRepository.insert(pool, {
        id: session.streamId,
        workspaceId: workspace,
        type: "channel",
        visibility: "private",
        companionMode: "off",
        createdBy: session.initiatingUserId ?? userId(),
      })
    }
    const ai = createAI({
      openrouter: { apiKey: "test-key", fetch: transport.fetch },
      spendingGate: createSpendingGate({ spendingService: service, routes: [PROFILE] }),
    })
    await new InProcessTurnDriver({ ai }).runTurn(
      {
        delivery: TurnDeliveries.PLAINTEXT,
        model: ai.getLanguageModel(MODEL),
        modelString: MODEL,
        systemPrompt: "Reply.",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
        spending: {
          workspaceId: workspace,
          // A historical row has no sponsor; the runtime refuses to fund it.
          userId: session.initiatingUserId as string,
          sessionId: session.id,
          executionGeneration: session.executionGeneration,
          operationId: session.id,
          purpose: "assistant_turn",
        },
      },
      { commitMessage: async () => ({ messageId: messageId() }) }
    )
    return { messagesSent: 0, sentMessageIds: [], lastSeenSequence: 1n }
  }
}

const noWork = async () => ({ messagesSent: 0, sentMessageIds: [] as string[], lastSeenSequence: 1n })

function turn(overrides: Partial<Parameters<typeof withCompanionSession>[0]> = {}) {
  const base = {
    pool,
    triggerMessageId: messageId(),
    streamId: streamId(),
    personaId: personaId(),
    personaName: "Ariadne",
    workspaceId: workspaceId(),
    initiatingUserId: userId(),
    serverId: "server_a",
    initialSequence: 0n,
    ...overrides,
  }
  return {
    params: base,
    run: (
      work: Parameters<typeof withCompanionSession>[1],
      extra: Partial<Parameters<typeof withCompanionSession>[0]> = {}
    ) => withCompanionSession({ ...base, ...extra }, work),
  }
}

async function lifecycle(stream: string) {
  const events = await StreamEventRepository.list(pool, stream, {
    types: ["agent_session:started", "agent_session:completed", "agent_session:failed", "agent_session:interrupted"],
  })
  return events.map((event) => {
    const payload = event.payload as { error?: string; spendingStop?: AgentSessionSpendingStop }
    return payload.spendingStop ? [event.eventType, payload.error, payload.spendingStop] : [event.eventType]
  })
}

async function outboxTypes(stream: string): Promise<string[]> {
  const { rows } = await pool.query<{ event_type: string }>(
    "SELECT event_type FROM outbox WHERE payload->>'streamId' = $1 ORDER BY id",
    [stream]
  )
  return rows.map((row) => row.event_type)
}

async function row(id: string) {
  const session = await AgentSessionRepository.findById(pool, id)
  return (
    session && {
      status: session.status,
      generation: session.executionGeneration,
      sponsor: session.initiatingUserId,
      stopReason: session.stopReason,
    }
  )
}

async function onlySession(trigger: string): Promise<AgentSession> {
  const session = await AgentSessionRepository.findByTriggerMessage(pool, trigger)
  if (!session) throw new Error("no session")
  return session
}

/** Ages the heartbeat past the stale threshold from the database clock, as a dead executor would. */
async function ageHeartbeat(id: string): Promise<void> {
  await pool.query("UPDATE agent_sessions SET heartbeat_at = NOW() - INTERVAL '120 seconds' WHERE id = $1", [id])
}

async function attemptsFor(workspace: string) {
  const { rows } = await pool.query<{ sponsor_user_id: string; state: string }>(
    "SELECT sponsor_user_id, state FROM ai_spending_attempts WHERE workspace_id = $1",
    [workspace]
  )
  return rows
}

async function waitForAdvisoryLockWait(): Promise<void> {
  for (let waited = 0; waited < 5000; waited += 25) {
    const { rows } = await pool.query(
      "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory'"
    )
    if (rows.length > 0) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("the owner never waited on the turn lock")
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

describe("one live executor per session", () => {
  test("a second delivery while the owner is live is busy, runs nothing, and the owner completes cleanly", async () => {
    const t = turn()
    const claimed = deferred()
    const release = deferred()
    const registry = new SessionAbortRegistry()
    let winnerController: AbortController | undefined
    let loserWorkCalls = 0

    const winner = t.run(async (session) => {
      winnerController = registry.register(
        session.id,
        { workspaceId: t.params.workspaceId, streamId: t.params.streamId },
        session.executionGeneration
      )
      try {
        claimed.resolve()
        await release.promise
        return noWork()
      } finally {
        registry.unregister(session.id, session.executionGeneration)
      }
    })
    await claimed.promise

    const loser = await t.run(async () => {
      loserWorkCalls++
      return noWork()
    })
    const controllerWhileLoserReturned = registry.get(loser.sessionId ?? "")
    release.resolve()
    const won = await winner

    expect({
      loser: { ...loser, heartbeatAt: loser.status === "busy" ? "date" : null },
      loserWorkCalls,
      controllerKept: controllerWhileLoserReturned === winnerController,
      won: won.status,
      row: await row(won.sessionId!),
      events: await lifecycle(t.params.streamId),
      outbox: await outboxTypes(t.params.streamId),
    }).toEqual({
      loser: { status: "busy", sessionId: won.sessionId!, heartbeatAt: "date" },
      loserWorkCalls: 0,
      controllerKept: true,
      won: "completed",
      row: { status: "completed", generation: 1, sponsor: t.params.initiatingUserId, stopReason: null },
      events: [["agent_session:started"], ["agent_session:completed"]],
      outbox: ["agent_session:started", "agent_session:completed"],
    })
  })

  test("a replaced executor cannot heartbeat, fail, complete, orphan-fail or unregister the newer generation", async () => {
    const t = turn({ attempt: 0, maxAttempts: 5 })
    const registry = new SessionAbortRegistry()
    const gen1Claimed = deferred()
    const gen1Throw = deferred()
    const gen2Claimed = deferred()
    const gen2Finish = deferred()
    let gen2Controller: AbortController | undefined
    const context = { workspaceId: t.params.workspaceId, streamId: t.params.streamId }

    const gen1 = t.run(async (session) => {
      registry.register(session.id, context, session.executionGeneration)
      try {
        gen1Claimed.resolve()
        await gen1Throw.promise
        throw new SpendingDuplicateRequestError("attempt_x", "dispatched")
      } finally {
        registry.unregister(session.id, session.executionGeneration)
      }
    })
    await gen1Claimed.promise
    const gen1Session = await onlySession(t.params.triggerMessageId)
    await ageHeartbeat(gen1Session.id)

    const gen2 = t.run(
      async (session) => {
        gen2Controller = registry.register(session.id, context, session.executionGeneration)
        try {
          gen2Claimed.resolve()
          await gen2Finish.promise
          return noWork()
        } finally {
          registry.unregister(session.id, session.executionGeneration)
        }
      },
      { serverId: "server_b" }
    )
    await gen2Claimed.promise

    const heartbeatBefore = (await onlySession(t.params.triggerMessageId)).heartbeatAt
    await AgentSessionRepository.updateHeartbeat(pool, gen1Session.id, 1)
    const staleComplete = await AgentSessionRepository.completeSession(pool, gen1Session.id, {
      lastSeenSequence: 1n,
      expectedGeneration: 1,
    })
    const staleOrphanFail = await withTransaction(pool, (tx) =>
      failSessionWithLifecycleInTransaction(tx, gen1Session, null, "Session orphaned (stale heartbeat)")
    )

    gen1Throw.resolve()
    const gen1Result = await gen1
    const afterGen1 = {
      row: await row(gen1Session.id),
      heartbeatUnchanged:
        (await onlySession(t.params.triggerMessageId)).heartbeatAt?.getTime() === heartbeatBefore?.getTime(),
      controllerSurvives: registry.get(gen1Session.id) === gen2Controller,
    }
    gen2Finish.resolve()
    const gen2Result = await gen2

    expect({
      staleComplete,
      staleOrphanFail,
      gen1Result,
      afterGen1,
      gen2Result: gen2Result.status,
      row: await row(gen1Session.id),
      events: await lifecycle(t.params.streamId),
    }).toEqual({
      staleComplete: null,
      staleOrphanFail: false,
      gen1Result: { status: "skipped", sessionId: null, reason: "execution superseded" },
      afterGen1: {
        row: { status: "running", generation: 2, sponsor: t.params.initiatingUserId, stopReason: null },
        heartbeatUnchanged: true,
        controllerSurvives: true,
      },
      gen2Result: "completed",
      row: { status: "completed", generation: 2, sponsor: t.params.initiatingUserId, stopReason: null },
      events: [["agent_session:started"], ["agent_session:completed"]],
    })
  })
})

describe("persisted financial stops", () => {
  test("a budget denial stops the session for good; raising the limit does not reopen it", async () => {
    const workspace = await seedEnforcedWorkspace("0")
    const t = turn({ workspaceId: workspace, attempt: 0, maxAttempts: 5 })
    const transport = provider(replyOk)

    const first = await t.run(paidWork(workspace, transport))
    await setLimits(workspace, "5")
    const redelivered = await t.run(paidWork(workspace, transport), { attempt: 1 })
    const session = await onlySession(t.params.triggerMessageId)

    expect({
      first,
      redelivered,
      physical: transport.requests,
      row: await row(session.id),
      events: await lifecycle(t.params.streamId),
      outbox: await outboxTypes(t.params.streamId),
    }).toEqual({
      first: { status: "failed", sessionId: session.id, willRetry: false, retryable: false, committedGeneration: 1 },
      redelivered: { status: "skipped", sessionId: null, reason: "stopped:spending_denied" },
      physical: 0,
      row: { status: "failed", generation: 1, sponsor: t.params.initiatingUserId, stopReason: "spending_denied" },
      events: [
        ["agent_session:started"],
        [
          "agent_session:failed",
          "spending_denied",
          { reason: "spending_denied", code: "LIMIT_EXCEEDED", stage: "agent" },
        ],
      ],
      outbox: ["agent_session:started", "agent_session:failed"],
    })
  })

  test("an unknown dispatched outcome keeps its commitment and stops; redeliveries buy and emit nothing", async () => {
    const workspace = await seedEnforcedWorkspace("5")
    const t = turn({ workspaceId: workspace, attempt: 0, maxAttempts: 5 })
    const transport = provider(() => Promise.reject(new TypeError("socket hang up")))

    const first = await t.run(paidWork(workspace, transport))
    const physicalAfterFirst = transport.requests
    const replays = [
      await t.run(paidWork(workspace, transport), { attempt: 1 }),
      await t.run(paidWork(workspace, transport), { attempt: 1 }),
    ]
    const session = await onlySession(t.params.triggerMessageId)

    expect({
      first,
      replays,
      physicalAfterFirst,
      physicalAfterReplays: transport.requests,
      attempts: await attemptsFor(workspace),
      row: await row(session.id),
      events: await lifecycle(t.params.streamId),
    }).toEqual({
      first: { status: "failed", sessionId: session.id, willRetry: false, retryable: false, committedGeneration: 1 },
      replays: [
        { status: "skipped", sessionId: null, reason: "stopped:spending_outcome_unknown" },
        { status: "skipped", sessionId: null, reason: "stopped:spending_outcome_unknown" },
      ],
      physicalAfterFirst: 1,
      physicalAfterReplays: 1,
      attempts: [{ sponsor_user_id: t.params.initiatingUserId, state: "unknown" }],
      row: {
        status: "failed",
        generation: 1,
        sponsor: t.params.initiatingUserId,
        stopReason: "spending_outcome_unknown",
      },
      events: [
        ["agent_session:started"],
        ["agent_session:failed", "spending_outcome_unknown", { reason: "spending_outcome_unknown" }],
      ],
    })
  })

  test("a stop whose transaction fails is not acknowledged: the call rejects and nothing is persisted", async () => {
    const workspace = await seedEnforcedWorkspace("0")
    const t = turn({ workspaceId: workspace, attempt: 0, maxAttempts: 5 })
    const transport = provider(replyOk)

    const outcome = await t
      .run(paidWork(workspace, transport), {
        onTerminalFailure: async () => {
          throw new Error("database went away")
        },
      })
      .then(
        (result) => ({ resolved: result }),
        (error: Error) => ({ rejected: error.message })
      )
    const session = await onlySession(t.params.triggerMessageId)

    expect({
      outcome,
      row: await row(session.id),
      events: await lifecycle(t.params.streamId),
    }).toEqual({
      outcome: { rejected: "database went away" },
      row: { status: "running", generation: 1, sponsor: t.params.initiatingUserId, stopReason: null },
      events: [["agent_session:started"]],
    })
  })
})

describe("the session's sponsor", () => {
  test("another user's delivery cannot resume, mutate or charge the session", async () => {
    const workspace = await seedEnforcedWorkspace("5")
    const t = turn({ workspaceId: workspace, attempt: 0, maxAttempts: 5 })
    await t.run(async () => {
      throw new Error("transient")
    })
    const session = await onlySession(t.params.triggerMessageId)
    const before = await row(session.id)
    const transport = provider(replyOk)

    const intruder = await t.run(paidWork(workspace, transport), { initiatingUserId: userId(), attempt: 1 })

    expect({
      intruder,
      row: await row(session.id),
      physical: transport.requests,
      attempts: await attemptsFor(workspace),
    }).toEqual({
      intruder: { status: "skipped", sessionId: null, reason: "sponsor_mismatch" },
      row: before,
      physical: 0,
      attempts: [],
    })
    expect(before).toEqual({ status: "failed", generation: 1, sponsor: t.params.initiatingUserId, stopReason: null })
  })

  test("a historical session without a sponsor is never stamped and stops before any ledger row under enforcement", async () => {
    const workspace = await seedEnforcedWorkspace("5")
    const t = turn({ workspaceId: workspace })
    const historical = await AgentSessionRepository.insertRunningOrSkip(pool, {
      id: sessionId(),
      streamId: t.params.streamId,
      personaId: t.params.personaId,
      triggerMessageId: t.params.triggerMessageId,
      serverId: "server_old",
      initialSequence: 0n,
    })
    await AgentSessionRepository.failExecution(pool, historical!.id, { generation: 1, error: "crashed" })
    const transport = provider(replyOk)

    const result = await t.run(paidWork(workspace, transport))

    expect({
      result,
      row: await row(historical!.id),
      physical: transport.requests,
      attempts: await attemptsFor(workspace),
      events: await lifecycle(t.params.streamId),
    }).toEqual({
      result: {
        status: "failed",
        sessionId: historical!.id,
        willRetry: false,
        retryable: false,
        committedGeneration: 2,
      },
      row: { status: "failed", generation: 2, sponsor: null, stopReason: "spending_denied" },
      physical: 0,
      attempts: [],
      events: [["agent_session:failed", "spending_denied", { reason: "spending_denied", code: "MISSING_CONTEXT" }]],
    })
  })
})

describe("ordinary failures keep today's retry policy", () => {
  test("a retryable error is interrupted, then the redelivery resumes the same session and completes", async () => {
    const t = turn({ attempt: 0, maxAttempts: 5 })

    const first = await t.run(async () => {
      throw new Error("provider timeout")
    })
    const retried = await t.run(noWork, { attempt: 1, serverId: "server_b" })

    expect({
      first,
      retried: retried.status,
      sameSession: retried.sessionId === first.sessionId,
      row: await row(first.sessionId!),
      events: await lifecycle(t.params.streamId),
    }).toEqual({
      first: {
        status: "failed",
        sessionId: first.sessionId!,
        willRetry: true,
        retryable: true,
        committedGeneration: 1,
      },
      retried: "completed",
      sameSession: true,
      row: { status: "completed", generation: 2, sponsor: t.params.initiatingUserId, stopReason: null },
      events: [["agent_session:started"], ["agent_session:interrupted"], ["agent_session:completed"]],
    })
  })
})

describe("the broadcast stop is public", () => {
  test("should carry only reason, denial code and stage when the spending error holds amounts, attempt ids and receipts", async () => {
    const secrets = {
      cutoffUsd: "12.34",
      settledUsd: "5.67",
      committedUsd: "8.90",
      maxCostUsd: "0.0042",
      attemptId: "aisa_secret_attempt",
      receipt: { generationId: "gen_secret_receipt", costUsd: "0.0031" },
      sponsorNote: "secret-extra-key",
    }
    const secretStrings = [
      "12.34",
      "5.67",
      "8.90",
      "0.0042",
      "aisa_secret_attempt",
      "gen_secret_receipt",
      "0.0031",
      "secret-extra-key",
      "sponsorNote",
    ]
    const cases = [
      {
        err: new SpendingDeniedError("LIMIT_EXCEEDED", { ...secrets, stage: "agent" }),
        stop: { reason: "spending_denied", code: "LIMIT_EXCEEDED", stage: "agent" },
      },
      {
        err: new SpendingDeniedError("NOT_PROVISIONED", { ...secrets, stage: "not-a-stage" }),
        stop: { reason: "spending_denied", code: "NOT_PROVISIONED" },
      },
      {
        err: new SpendingOutcomeUnknownError(
          [{ attemptId: secrets.attemptId, status: "held", reason: "cost_unavailable", providerRequestSent: true }],
          new Error(`receipt ${secrets.receipt.generationId}`)
        ),
        stop: { reason: "spending_outcome_unknown" },
      },
      {
        err: new SpendingResultUnavailableError(new Error(`receipt ${secrets.receipt.generationId}`)),
        stop: { reason: "spending_result_unavailable" },
      },
      {
        err: new SpendingDuplicateRequestError(secrets.attemptId, "settled"),
        stop: { reason: "spending_replay_blocked" },
      },
    ]

    const observed = []
    for (const c of cases) {
      const t = turn({ attempt: 0, maxAttempts: 5 })
      const result = await t.run(async () => {
        throw c.err
      })
      const [failed] = await StreamEventRepository.list(pool, t.params.streamId, { types: ["agent_session:failed"] })
      const { rows } = await pool.query<{ payload: unknown }>(
        "SELECT payload FROM outbox WHERE payload->>'streamId' = $1 AND event_type = 'agent_session:failed'",
        [t.params.streamId]
      )
      const broadcast = JSON.stringify([failed?.payload, rows])
      observed.push({
        result: result.status,
        payload: failed?.payload,
        outboxRows: rows.length,
        leaked: secretStrings.filter((secret) => broadcast.includes(secret)),
        internalError: (await AgentSessionRepository.findById(pool, result.sessionId!))?.error,
      })
    }

    expect(observed).toEqual(
      cases.map((c) => ({
        result: "failed",
        payload: {
          sessionId: expect.any(String),
          stepCount: 0,
          error: c.stop.reason,
          traceId: expect.any(String),
          effects: [],
          failedAt: expect.any(String),
          spendingStop: c.stop,
        },
        outboxRows: 1,
        leaked: [],
        internalError: String(c.err),
      }))
    )
  })
})

describe("an ordinary failure that cannot be persisted", () => {
  test("rejects the delivery instead of reporting a terminal failure nobody wrote", async () => {
    const t = turn()
    const outcome = await t
      .run(
        async () => {
          throw new Error("provider down")
        },
        {
          onTerminalFailure: async () => {
            throw new Error("lifecycle write failed")
          },
        }
      )
      .then(
        (result) => ({ result }),
        (error: unknown) => ({ error: String(error) })
      )
    const session = await onlySession(t.params.triggerMessageId)

    expect({ outcome, row: await row(session.id), events: await lifecycle(t.params.streamId) }).toEqual({
      outcome: { error: "Error: lifecycle write failed" },
      row: { status: "running", generation: 1, sponsor: t.params.initiatingUserId, stopReason: null },
      events: [["agent_session:started"]],
    })
  })
})

describe("a generation orphan cleanup already failed", () => {
  for (const mode of ["retryable", "spending stop"] as const) {
    test(`should persist this execution's ${mode} outcome without a second terminal event`, async () => {
      const t = turn({ attempt: 0, maxAttempts: 5 })
      const claimed = deferred()
      const throwNow = deferred()
      const running = t.run(async () => {
        claimed.resolve()
        await throwNow.promise
        throw mode === "spending stop" ? new SpendingDuplicateRequestError("aisa_x", "settled") : new Error("timeout")
      })
      await claimed.promise
      const session = await onlySession(t.params.triggerMessageId)
      const stream = { id: t.params.streamId, workspaceId: t.params.workspaceId, rootStreamId: null } as Parameters<
        typeof failSessionWithLifecycleInTransaction
      >[2]
      const orphanWon = await withTransaction(pool, (tx) =>
        failSessionWithLifecycleInTransaction(tx, session, stream, "Session orphaned (stale heartbeat)")
      )
      throwNow.resolve()
      const result = await running
      const afterFailure = { row: await row(session.id), events: await lifecycle(t.params.streamId) }
      const redelivered = await t.run(noWork, { attempt: 1 })

      const stop = mode === "spending stop"
      expect({ orphanWon, result, afterFailure, redelivered: redelivered.status }).toEqual({
        orphanWon: true,
        result: {
          status: "failed",
          sessionId: session.id,
          willRetry: !stop,
          retryable: !stop,
          committedGeneration: null,
        },
        afterFailure: {
          row: {
            status: "failed",
            generation: 1,
            sponsor: t.params.initiatingUserId,
            stopReason: stop ? "spending_replay_blocked" : null,
          },
          events: [["agent_session:started"], ["agent_session:failed"]],
        },
        redelivered: stop ? "skipped" : "completed",
      })
    })
  }
})

describe("busy deliveries are deferred, never dropped", () => {
  test("should give two personas answering one trigger their own sessions, deferring the second while the first holds the stream", async () => {
    const a = turn()
    const personaB = personaId()
    const aRunning = deferred()
    const aFinish = deferred()
    const aResult = a.run(async () => {
      aRunning.resolve()
      await aFinish.promise
      return noWork()
    })
    await aRunning.promise
    let bWork = 0
    const bTurn = () =>
      a.run(
        async () => {
          bWork++
          return noWork()
        },
        { personaId: personaB, personaName: "Borges" }
      )
    const deferredB = await bTurn()
    aFinish.resolve()
    const finishedA = await aResult
    const ranB = await bTurn()
    const replayB = await bTurn()

    const sessions = await AgentSessionRepository.listByTriggerMessage(pool, a.params.triggerMessageId)
    const byPersona = new Map(sessions.map((s) => [s.personaId, s]))
    expect({
      deferredB,
      finishedA: finishedA.status,
      ranB: ranB.status,
      replayB,
      bWork,
      sessions: sessions.map((s) => [s.personaId, s.status]).sort(),
    }).toEqual({
      deferredB: {
        status: "busy",
        sessionId: byPersona.get(a.params.personaId)!.id,
        heartbeatAt: expect.any(Date),
      },
      finishedA: "completed",
      ranB: "completed",
      replayB: { status: "skipped", sessionId: null, reason: "session already completed" },
      bWork: 1,
      sessions: [
        [a.params.personaId, "completed"],
        [personaB, "completed"],
      ].sort(),
    })
    expect(ranB.sessionId).toBe(byPersona.get(personaB)!.id)
  })

  test("should run one session when a duplicate delivery looks up the turn while the first owner completes fast", async () => {
    const t = turn()
    const lookedUp = deferred()
    const firstDone = deferred()
    const lockCompanionTurn = AgentSessionRepository.lockCompanionTurn
    let calls = 0
    const spy = spyOn(AgentSessionRepository, "lockCompanionTurn").mockImplementation(async (db, key) => {
      const found = await lockCompanionTurn(db, key)
      if (++calls === 1) {
        lookedUp.resolve()
        // Hold the duplicate between lookup and insert until the owner has either finished or is waiting behind it.
        await Promise.race([firstDone.promise, waitForAdvisoryLockWait()])
      }
      return found
    })
    let work = 0
    const counted = async () => {
      work++
      return noWork()
    }
    try {
      const duplicate = t.run(counted)
      await lookedUp.promise
      const owner = t.run(counted).finally(() => firstDone.resolve())
      const results = [await duplicate, await owner].map((r) => r.status).sort()
      const rows = await AgentSessionRepository.listByTriggerMessage(pool, t.params.triggerMessageId)
      expect({
        completed: results.filter((status) => status === "completed").length,
        duplicate: results.find((status) => status !== "completed"),
        work,
        rows: rows.length,
      }).toEqual({ completed: 1, duplicate: expect.stringMatching(/^(busy|skipped)$/), work: 1, rows: 1 })
    } finally {
      spy.mockRestore()
    }
  })

  test("should be busy, not skipped, when a concurrent delivery of the same turn inserts first", async () => {
    const t = turn()
    const client = await pool.connect()
    let workCalls = 0
    try {
      await client.query("BEGIN")
      const owner = await AgentSessionRepository.insertRunningOrSkip(client, {
        id: sessionId(),
        streamId: t.params.streamId,
        personaId: t.params.personaId,
        triggerMessageId: t.params.triggerMessageId,
        serverId: "server_owner",
        initialSequence: 0n,
        initiatingUserId: t.params.initiatingUserId,
      })
      const loser = t.run(async () => {
        workCalls++
        return noWork()
      })
      for (let waited = 0; ; waited += 25) {
        const { rows } = await pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%INSERT INTO agent_sessions%'"
        )
        if (rows.length > 0) break
        if (waited > 5000) throw new Error("the second delivery never reached the insert")
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      await client.query("COMMIT")

      expect({ result: await loser, workCalls, row: await row(owner!.id) }).toEqual({
        result: { status: "busy", sessionId: owner!.id, heartbeatAt: owner!.heartbeatAt! },
        workCalls: 0,
        row: { status: "running", generation: 1, sponsor: t.params.initiatingUserId, stopReason: null },
      })
    } finally {
      client.release()
    }
  })

  test(
    "should re-enqueue a busy job once through the real queue, hold it until the owner is stale, then take the turn over",
    async () => {
      const t = turn()
      const owner = await AgentSessionRepository.insertRunningOrSkip(pool, {
        id: sessionId(),
        streamId: t.params.streamId,
        personaId: t.params.personaId,
        triggerMessageId: t.params.triggerMessageId,
        serverId: "server_dead",
        initialSequence: 0n,
        initiatingUserId: t.params.initiatingUserId,
      })
      // A dead executor whose last heartbeat, by the database clock, is still fresh for a few more seconds.
      await pool.query("UPDATE agent_sessions SET heartbeat_at = NOW() - INTERVAL '52 seconds' WHERE id = $1", [
        owner!.id,
      ])
      const heartbeatAt = (await onlySession(t.params.triggerMessageId)).heartbeatAt!

      const manager = new QueueManager({
        pool,
        queueRepository: QueueRepository,
        tokenPoolRepository: TokenPoolRepository,
        pollIntervalMs: 50,
        lockDurationMs: 5000,
        maxRetries: 1,
      })
      const deliveries: string[] = []
      const tookOver = deferred()
      const worker = createPersonaAgentWorker({
        serverId: "server_queue",
        pool,
        jobQueue: manager,
        agent: {
          run: async (input) => {
            const result = await t.run(
              async () => {
                tookOver.resolve()
                return noWork()
              },
              { initiatingUserId: input.initiatingUserId, serverId: input.serverId }
            )
            deliveries.push(result.status)
            return result.status === "busy"
              ? {
                  sessionId: result.sessionId,
                  messagesSent: 0,
                  sentMessageIds: [],
                  status: "skipped",
                  skipReason: "session_busy",
                  busyHeartbeatAt: result.heartbeatAt,
                }
              : { sessionId: result.sessionId, messagesSent: 0, sentMessageIds: [], status: "skipped" }
          },
        },
      })
      manager.registerHandler(JobQueues.PERSONA_AGENT, worker)
      const data: PersonaAgentJobData = {
        workspaceId: t.params.workspaceId,
        streamId: t.params.streamId,
        messageId: t.params.triggerMessageId,
        personaId: t.params.personaId,
        triggeredBy: t.params.initiatingUserId,
      }
      const queueRows = async () => {
        const { rows } = await pool.query<{
          id: string
          payload: unknown
          process_after: Date | null
          claimed_at: Date | null
          completed_at: Date | null
        }>(
          "SELECT id, payload, process_after, claimed_at, completed_at FROM queue_messages WHERE workspace_id = $1 ORDER BY inserted_at",
          [t.params.workspaceId]
        )
        return rows
      }
      const waitFor = async (check: () => Promise<boolean>, ms: number, what: string) => {
        const deadline = Date.now() + ms
        while (!(await check())) {
          if (Date.now() > deadline) throw new Error(`timed out: ${what}`)
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
      }

      const originalId = await manager.send(JobQueues.PERSONA_AGENT, data)
      const deferredId = `queue_busy_${createHash("sha256").update(originalId).digest("hex").slice(0, 32)}`
      manager.start()
      try {
        await waitFor(
          async () => (await QueueRepository.getById(pool, originalId))?.completedAt != null,
          5000,
          "original job acknowledged"
        )
        // The same job delivered again while the owner is still fresh enqueues nothing new.
        await worker({ id: originalId, name: JobQueues.PERSONA_AGENT, data, attempt: 0, maxAttempts: 5 })
        const whileBusy = (await queueRows()).map((r) => ({
          id: r.id,
          payload: r.payload,
          processAfter: r.process_after?.getTime() ?? null,
          claimed: r.claimed_at !== null && r.id === deferredId,
          completed: r.completed_at !== null,
        }))
        const deferredProcessAfter = heartbeatAt.getTime() + 65_000

        await Promise.race([
          tookOver.promise,
          new Promise((_, reject) => setTimeout(() => reject(new Error("deferred job never took over")), 25_000)),
        ])
        await waitFor(
          async () => (await QueueRepository.getById(pool, deferredId))?.completedAt != null,
          5000,
          "deferred job acknowledged"
        )
        const deferredRow = (await queueRows()).find((r) => r.id === deferredId)

        expect({
          whileBusy,
          deliveries,
          claimedNotBeforeProcessAfter: deferredRow!.claimed_at!.getTime() >= deferredProcessAfter,
          finalQueue: (await queueRows()).map((r) => ({ id: r.id, completed: r.completed_at !== null })),
          row: await row(owner!.id),
          events: await lifecycle(t.params.streamId),
        }).toEqual({
          whileBusy: [
            { id: originalId, payload: data, processAfter: null, claimed: false, completed: true },
            { id: deferredId, payload: data, processAfter: deferredProcessAfter, claimed: false, completed: false },
          ],
          deliveries: ["busy", "busy", "completed"],
          claimedNotBeforeProcessAfter: true,
          finalQueue: [
            { id: originalId, completed: true },
            { id: deferredId, completed: true },
          ],
          row: { status: "completed", generation: 2, sponsor: t.params.initiatingUserId, stopReason: null },
          events: [["agent_session:completed"]],
        })
      } finally {
        await manager.stop()
      }
    },
    { timeout: 45_000 }
  )
})
