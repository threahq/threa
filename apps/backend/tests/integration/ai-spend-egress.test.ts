import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Request, Response } from "express"
import type { Pool } from "pg"
import { AISpendDeniedError, createModelRegistry } from "@threahq/agent-runtime"
import { AuthorTypes, ENCLAVE_CALLBACK_TOKEN_HEADER } from "@threahq/types"
import { addTestMember, setupIsolatedTestDatabase, withTransaction } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { EventService } from "../../src/features/messaging"
import { StreamMemberRepository, StreamRepository } from "../../src/features/streams"
import {
  E2eStreamActorsRepository,
  E2eStreamsRepository,
  StreamE2eKeyWrapsRepository,
} from "../../src/features/e2e-streams"
import { AgentSessionRepository, ARIADNE_AGENT_ID, hashCallbackToken } from "../../src/features/agents"
import { AICostService, AIBudgetRepository, AISpendGate } from "../../src/features/ai-usage"
import { VoiceTranscriptionService } from "../../src/features/voice-transcription"
import { UserPreferencesService } from "../../src/features/user-preferences"
import { EnclaveClaimService, EnclaveInvocationsRepository } from "../../src/features/enclave-runtimes"
import { createEnclaveSessionHandlers } from "../../src/features/enclave-runtimes/session-handlers"
import { aiBudgetId, enclaveInvocationId, sessionId, streamId, userId, workspaceId } from "../../src/lib/id"

describe("AI spend limits at the voice and enclave egress points", () => {
  let pool: Pool
  let cleanup: () => Promise<void>
  let spendGate: AISpendGate
  let costService: AICostService

  beforeAll(async () => {
    const isolated = await setupIsolatedTestDatabase("ai_spend_egress")
    pool = isolated.pool
    cleanup = isolated.cleanup
    spendGate = new AISpendGate({ pool })
    costService = new AICostService({ pool })
  }, 120_000)

  afterAll(async () => cleanup(), 120_000)

  async function seedWorkspace(options: { aiDisabled?: boolean } = {}) {
    const workspace = workspaceId()
    const workosUserId = userId()
    const member = await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: workspace,
        name: "Spend",
        slug: workspace,
        createdBy: workosUserId,
      })
      return addTestMember(client, workspace, workosUserId)
    })
    if (options.aiDisabled) {
      await AIBudgetRepository.upsertPartial(pool, { id: aiBudgetId(), workspaceId: workspace })
      await pool.query(
        "UPDATE ai_budgets SET operator_ai_disabled = true, ai_disabled = true WHERE workspace_id = $1",
        [workspace]
      )
    }
    return { workspace, workosUserId, memberId: member.id }
  }

  async function seedSealedTrigger(workspace: string, memberId: string) {
    const target = streamId()
    await withTransaction(pool, async (client) => {
      await StreamRepository.insert(client, {
        id: target,
        workspaceId: workspace,
        type: "channel",
        visibility: "private",
        companionMode: "off",
        createdBy: memberId,
      })
      await StreamMemberRepository.insert(client, target, memberId)
    })
    await E2eStreamsRepository.markStreamE2e(pool, {
      streamId: target,
      workspaceId: workspace,
      ownerUserId: memberId,
      ownerUserKeyId: `ukey_${crypto.randomUUID()}`,
      currentKeyGeneration: 3,
    })
    const { message } = await new EventService(pool).createMessageForPrincipalReturningConversation(
      { kind: "user", userId: memberId },
      {
        workspaceId: workspace,
        streamId: target,
        authorId: memberId,
        authorType: AuthorTypes.USER,
        contentJson: { type: "doc", content: [] },
        contentMarkdown: "",
        ciphertext: Buffer.from("sealed trigger"),
        envelope: { v: 2, keyGeneration: 3, iv: "aXY=", aad: "YWFk" },
        e2eVersion: 2,
      }
    )
    return { target, trigger: message }
  }

  function voiceService() {
    return new VoiceTranscriptionService({
      pool,
      userPreferencesService: new UserPreferencesService(pool),
      spendGate,
      costService,
      modelRegistry: createModelRegistry(),
    })
  }

  test("should record transcription cost once when a session is finalized and then finalized again", async () => {
    const { workspace, memberId } = await seedWorkspace()
    const service = voiceService()
    const session = await service.createSession({
      workspaceId: workspace,
      userId: memberId,
      model: "elevenlabs:scribe-v2-realtime",
    })

    await service.finishSession({
      workspaceId: workspace,
      userId: memberId,
      sessionId: session.id,
      totalAudioMs: 1_800_000,
    })
    await service.abortSession({
      workspaceId: workspace,
      userId: memberId,
      sessionId: session.id,
      totalAudioMs: 1_800_000,
    })

    const usage = await pool.query(
      `SELECT user_id, function_id, model, provider, origin, cost_usd::float8 AS cost_usd, metadata
       FROM ai_usage_records WHERE workspace_id = $1 AND session_id = $2`,
      [workspace, session.id]
    )
    expect(usage.rows).toEqual([
      {
        user_id: memberId,
        function_id: "voice-transcription-realtime",
        model: "scribe-v2-realtime",
        provider: "elevenlabs",
        origin: "user",
        cost_usd: 0.195,
        metadata: { totalAudioMs: 1_800_000 },
      },
    ])
  })

  test("should refuse to start a voice relay when the operator has switched AI off", async () => {
    const { workspace, workosUserId, memberId } = await seedWorkspace({ aiDisabled: true })
    const service = voiceService()
    const session = await service.createSession({
      workspaceId: workspace,
      userId: memberId,
      model: "elevenlabs:scribe-v2-realtime",
    })

    const error = await service
      .getRelaySession({ workspaceId: workspace, workosUserId, sessionId: session.id })
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(AISpendDeniedError)
    expect(error).toMatchObject({
      workspaceId: workspace,
      userId: memberId,
      functionId: "voice-transcription-realtime",
      reason: "operator_disabled",
    })
  })

  test("should fail the enclave session with the spend denial and hand out no turn when AI is switched off", async () => {
    const { workspace, memberId } = await seedWorkspace({ aiDisabled: true })
    const { target, trigger } = await seedSealedTrigger(workspace, memberId)
    const keyId = `eik_${crypto.randomUUID()}`
    await StreamE2eKeyWrapsRepository.insertMany(pool, [
      {
        workspaceId: workspace,
        streamId: target,
        keyGeneration: 3,
        recipientKeyId: keyId,
        recipientKind: "enclave",
        wrapEnc: "ZW5j",
        wrapCt: "Y3Q=",
      },
    ])
    await E2eStreamActorsRepository.add(pool, workspace, target, "enclave", "enclave", null)
    const invocationId = enclaveInvocationId()
    await EnclaveInvocationsRepository.insertPending(pool, {
      id: invocationId,
      workspaceId: workspace,
      streamId: target,
      rootStreamId: target,
      messageId: trigger.id,
      triggeredBy: memberId,
    })
    const service = new EnclaveClaimService({
      pool,
      storage: { getObject: async () => Buffer.alloc(0) } as never,
      userPreferencesService: { getPreferences: async () => ({}) } as never,
      spendGate,
    })

    expect(await service.claimTurn(keyId)).toBeNull()

    const rows = await pool.query(
      `SELECT
         (SELECT status FROM enclave_invocations WHERE id = $1) AS invocation_status,
         (SELECT error_message FROM enclave_invocations WHERE id = $1) AS invocation_error,
         (SELECT status FROM agent_sessions WHERE trigger_message_id = $2) AS session_status,
         (SELECT payload->>'spendDenial' FROM stream_events
            WHERE stream_id = $3 AND event_type = 'agent_session:failed') AS spend_denial,
         (SELECT count(*)::int FROM stream_events
            WHERE stream_id = $3 AND event_type = 'agent_session:started') AS started_events`,
      [invocationId, trigger.id, target]
    )
    expect(rows.rows[0]).toEqual({
      invocation_status: "failed",
      invocation_error: "AI_SPEND_DENIED:operator_disabled",
      session_status: "failed",
      spend_denial: "operator_disabled",
      started_events: 1,
    })
  })

  test("should record the usage a failed enclave turn reports once when the fail ack is redelivered", async () => {
    const { workspace, memberId } = await seedWorkspace()
    const { target, trigger } = await seedSealedTrigger(workspace, memberId)
    const id = sessionId()
    const token = `enclave_${crypto.randomUUID()}`
    await AgentSessionRepository.insertRunningOrSkip(pool, {
      id,
      streamId: target,
      personaId: ARIADNE_AGENT_ID,
      triggerMessageId: trigger.id,
      initialSequence: trigger.sequence,
      callbackTokenHash: hashCallbackToken(token),
      replyKeyGeneration: 3,
    })
    const handlers = createEnclaveSessionHandlers({
      pool,
      io: { to: () => ({ emit: () => undefined }) } as never,
      eventService: new EventService(pool),
      costService,
    })
    const res = { status: () => res, end: () => res } as unknown as Response
    const req = {
      params: { id },
      header: (name: string) => (name === ENCLAVE_CALLBACK_TOKEN_HEADER ? token : undefined),
      body: {
        errorName: "Error",
        model: "openai/gpt-5.6-luna",
        usage: { promptTokens: 1200, completionTokens: 300, cost: 0.0042 },
      },
    } as unknown as Request

    await handlers.fail(req, res)
    await expect(handlers.fail(req, res)).rejects.toMatchObject({ status: 409 })

    const usage = await pool.query(
      `SELECT user_id, function_id, model, provider, origin, prompt_tokens, completion_tokens, total_tokens,
         cost_usd::float8 AS cost_usd
       FROM ai_usage_records WHERE workspace_id = $1 AND session_id = $2`,
      [workspace, id]
    )
    expect(usage.rows).toEqual([
      {
        user_id: memberId,
        function_id: "enclave-agent-loop",
        model: "openai/gpt-5.6-luna",
        provider: "openrouter",
        origin: "user",
        prompt_tokens: 1200,
        completion_tokens: 300,
        total_tokens: 1500,
        cost_usd: 0.0042,
      },
    ])
  })
})
