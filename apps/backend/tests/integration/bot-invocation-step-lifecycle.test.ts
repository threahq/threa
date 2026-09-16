import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import type { Server } from "socket.io"
import { setupTestDatabase } from "./setup"
import { createBotRuntimeWriteOps } from "../../src/features/public-api"
import { BotInvocationRepository, type BotRuntimeService, type RecordStepFrame } from "../../src/features/bot-runtimes"
import { BotChannelAccessRepository, type BotChannelService } from "../../src/features/api-keys"
import { AgentSessionRepository } from "../../src/features/agents"
import { streamId, workspaceId, userId } from "../../src/lib/id"

describe("recordSteps plaintext tool step lifecycle", () => {
  let pool: Pool
  const ws = workspaceId()
  const botId = `bot_${Math.random().toString(36).slice(2, 10)}`
  const instanceId = "step-lifecycle-test"
  const stream = streamId()
  const author = userId()
  const invocationId = `binv_lifecycle_${ws.slice(-8)}`
  const claimToken = "tok_lifecycle"
  const emits: { event: string; payload: { step?: { id: string; stepType: string; completedAt?: string } } }[] = []

  beforeAll(async () => {
    pool = await setupTestDatabase()
    await pool.query("INSERT INTO workspaces (id, name, slug, created_by) VALUES ($1, 'Step lifecycle', $2, $3)", [
      ws,
      `step-lifecycle-${ws.slice(-8)}`,
      author,
    ])
    await pool.query(
      "INSERT INTO streams (id, workspace_id, type, visibility, created_by) VALUES ($1,$2,'channel','private',$3)",
      [stream, ws, author]
    )
    await pool.query("INSERT INTO bots (id, workspace_id, api_key_id, name) VALUES ($1,$2,$3,'Lifecycle bot')", [
      botId,
      ws,
      `key_${botId}`,
    ])
    await BotChannelAccessRepository.grantAccess(pool, {
      id: `bca_${botId}`,
      workspaceId: ws,
      botId,
      streamId: stream,
      grantedBy: author,
    })
    await BotInvocationRepository.insertIdempotent(pool, {
      id: invocationId,
      workspaceId: ws,
      rootStreamId: stream,
      activeStreamId: stream,
      sourceMessageId: `msg_${invocationId}`,
      responseStreamId: stream,
      actorType: "bot",
      actorId: botId,
      trigger: "active-scratchpad",
      requiredCapability: "active-scratchpad",
      promptMarkdown: "run tools",
      authorUserId: author,
      mentionedActorSlugs: [],
      targetInstanceId: null,
      targetRuntimeSessionId: null,
      metadata: {},
      sourceMessageRevision: 0,
    })
    await pool.query(
      `UPDATE bot_invocations
       SET status = 'claimed', claimed_by_instance_id = $2, claim_token = $3, claim_expires_at = NOW() + interval '60 seconds',
           claimed_source_message_revision = source_message_revision
       WHERE id = $1`,
      [invocationId, instanceId, claimToken]
    )
    await AgentSessionRepository.insertRunningOrSkip(pool, {
      id: invocationId,
      streamId: stream,
      personaId: botId,
      triggerMessageId: `msg_${invocationId}`,
      initialSequence: 0n,
    })
  })

  afterAll(async () => {
    await pool.query("DELETE FROM bot_invocations WHERE workspace_id = $1", [ws])
    await pool.query("DELETE FROM agent_session_steps WHERE session_id = $1", [invocationId])
    await pool.query("DELETE FROM agent_sessions WHERE stream_id = $1", [stream])
    await pool.query("DELETE FROM bot_channel_access WHERE workspace_id = $1", [ws])
    await pool.query("DELETE FROM bots WHERE workspace_id = $1", [ws])
    await pool.query("DELETE FROM streams WHERE workspace_id = $1", [ws])
    await pool.query("DELETE FROM workspaces WHERE id = $1", [ws])
    await pool.end()
  })

  const ops = () =>
    createBotRuntimeWriteOps({
      pool,
      io: {
        to: () => {
          const target = {
            to: () => target,
            emit: (event: string, payload: (typeof emits)[number]["payload"]) => {
              emits.push({ event, payload })
            },
          }
          return target
        },
      } as unknown as Server,
      botRuntimeService: {
        findInvocationForCallback: (
          db: Parameters<typeof BotInvocationRepository.findForCallback>[0],
          params: Parameters<typeof BotInvocationRepository.findForCallback>[1]
        ) => BotInvocationRepository.findForCallback(db, params),
        findActiveClaimForUpdate: (
          db: Parameters<typeof BotInvocationRepository.findActiveClaimForUpdate>[0],
          params: Parameters<typeof BotInvocationRepository.findActiveClaimForUpdate>[1]
        ) => BotInvocationRepository.findActiveClaimForUpdate(db, params),
        findActiveClaim: (params: Parameters<typeof BotInvocationRepository.findActiveClaim>[1]) =>
          BotInvocationRepository.findActiveClaim(pool, params),
        findPresenceByInstance: async () => null,
        upsertPresenceFromBotKey: async () => null,
      } as unknown as BotRuntimeService,
      botChannelService: { isStreamAccessibleForBot: async () => true } as unknown as BotChannelService,
    })

  async function send(frame: RecordStepFrame) {
    emits.length = 0
    const result = await ops().recordSteps({
      workspaceId: ws,
      botId,
      invocationId,
      instanceId,
      claimToken,
      steps: [frame],
    })
    return { stepId: result.steps[0].stepId, emitted: emits.filter((e) => e.event.startsWith("agent_session:step:")) }
  }

  async function rows(clientStepId: string) {
    const result = await pool.query<{
      id: string
      step_type: string
      content: string
      duration_ms: number | null
    }>(
      `SELECT id, step_type, content,
              (EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000)::int AS duration_ms
       FROM agent_session_steps WHERE session_id = $1 AND client_step_id = $2`,
      [invocationId, clientStepId]
    )
    return result.rows
  }

  test("should finalize the started row in place with the reported duration", async () => {
    const start = await send({ stepType: "tool_call", content: "bash: ls", clientStepId: "call-a", phase: "started" })
    expect({ rows: await rows("call-a"), emitted: start.emitted.map((e) => [e.event, e.payload.step?.id]) }).toEqual({
      rows: [{ id: start.stepId, step_type: "tool_call", content: "bash: ls", duration_ms: null }],
      emitted: [["agent_session:step:started", start.stepId]],
    })

    const finish = await send({
      stepType: "tool_call",
      content: "bash: ls -> ok",
      clientStepId: "call-a",
      durationMs: 250,
    })
    expect({
      stepId: finish.stepId,
      rows: await rows("call-a"),
      emitted: finish.emitted.map((e) => [e.event, e.payload.step?.id]),
    }).toEqual({
      stepId: start.stepId,
      rows: [{ id: start.stepId, step_type: "tool_call", content: "bash: ls -> ok", duration_ms: 250 }],
      emitted: [["agent_session:step:completed", start.stepId]],
    })
  })

  test("should keep a tool_error finish as tool_error", async () => {
    const start = await send({ stepType: "tool_call", content: "bash: rm", clientStepId: "call-err", phase: "started" })
    await send({ stepType: "tool_error", content: "bash: rm failed", clientStepId: "call-err", durationMs: 10 })
    expect(await rows("call-err")).toEqual([
      { id: start.stepId, step_type: "tool_error", content: "bash: rm failed", duration_ms: 10 },
    ])
  })

  test("should insert one completed row when the finish arrives without a start, and ignore the late start", async () => {
    const finish = await send({
      stepType: "tool_call",
      content: "read: done",
      clientStepId: "call-late",
      durationMs: 40,
    })
    const lateStart = await send({
      stepType: "tool_call",
      content: "read",
      clientStepId: "call-late",
      phase: "started",
    })
    expect({ rows: await rows("call-late"), finishEmits: finish.emitted.map((e) => e.event), lateStart }).toEqual({
      rows: [{ id: finish.stepId, step_type: "tool_call", content: "read: done", duration_ms: 40 }],
      finishEmits: ["agent_session:step:completed"],
      lateStart: { stepId: finish.stepId, emitted: [] },
    })
  })

  test("should treat a replayed finish as a no-op", async () => {
    const start = await send({ stepType: "tool_call", content: "grep", clientStepId: "call-replay", phase: "started" })
    await send({ stepType: "tool_call", content: "grep: 3 hits", clientStepId: "call-replay", durationMs: 30 })
    const replay = await send({
      stepType: "tool_error",
      content: "grep: other",
      clientStepId: "call-replay",
      durationMs: 99,
    })
    expect({ rows: await rows("call-replay"), replay }).toEqual({
      rows: [{ id: start.stepId, step_type: "tool_call", content: "grep: 3 hits", duration_ms: 30 }],
      replay: { stepId: start.stepId, emitted: [] },
    })
  })

  test("should not touch the first tool's row when a second tool starts and finishes", async () => {
    const first = await send({ stepType: "tool_call", content: "one", clientStepId: "call-one", phase: "started" })
    const second = await send({ stepType: "tool_call", content: "two", clientStepId: "call-two", phase: "started" })
    await send({ stepType: "tool_call", content: "two: done", clientStepId: "call-two", durationMs: 5 })
    expect({ one: await rows("call-one"), two: await rows("call-two") }).toEqual({
      one: [{ id: first.stepId, step_type: "tool_call", content: "one", duration_ms: null }],
      two: [{ id: second.stepId, step_type: "tool_call", content: "two: done", duration_ms: 5 }],
    })
  })

  test("should reject an append whose caller-supplied step id already exists instead of retrying forever", async () => {
    const existing = await send({ stepType: "tool_call", content: "dup", clientStepId: "call-dup" })
    await expect(
      AgentSessionRepository.appendStep(pool, {
        id: existing.stepId,
        sessionId: invocationId,
        stepType: "tool_call",
        content: "dup again",
        startedAt: new Date(),
        completedAt: new Date(),
      })
    ).rejects.toThrow(`agent_session_steps row already exists for step id ${existing.stepId}`)
  })

  test("should close open steps when the session ends", async () => {
    const closedWithSession = async (stepId: string) => {
      const result = await pool.query<{ closed: boolean }>(
        `SELECT step.completed_at = session.completed_at AS closed
         FROM agent_session_steps step JOIN agent_sessions session ON session.id = step.session_id
         WHERE step.id = $1`,
        [stepId]
      )
      return result.rows[0]?.closed
    }

    const beforeComplete = await send({
      stepType: "tool_call",
      content: "hang",
      clientStepId: "call-hang-1",
      phase: "started",
    })
    const completed = await AgentSessionRepository.completeSession(pool, invocationId, { lastSeenSequence: 0n })
    const afterComplete = await closedWithSession(beforeComplete.stepId)

    await pool.query("UPDATE agent_sessions SET status = 'running', completed_at = NULL WHERE id = $1", [invocationId])
    const beforeFail = await send({
      stepType: "tool_call",
      content: "hang",
      clientStepId: "call-hang-2",
      phase: "started",
    })
    const failed = await AgentSessionRepository.updateStatus(pool, invocationId, "failed", { error: "runtime died" })

    expect({
      completed: completed?.status,
      afterComplete,
      failed: failed?.status,
      afterFail: await closedWithSession(beforeFail.stepId),
    }).toEqual({ completed: "completed", afterComplete: true, failed: "failed", afterFail: true })
  })
})
