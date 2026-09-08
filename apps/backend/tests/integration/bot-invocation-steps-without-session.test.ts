import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import type { Server } from "socket.io"
import { HttpError } from "@threahq/backend-common"
import { setupTestDatabase } from "./setup"
import { createBotRuntimeWriteOps } from "../../src/features/public-api"
import { BotInvocationRepository } from "../../src/features/bot-runtimes"
import type { BotRuntimeService } from "../../src/features/bot-runtimes"
import { BotChannelAccessRepository, type BotChannelService } from "../../src/features/api-keys"
import { AgentSessionRepository } from "../../src/features/agents"
import { streamId, workspaceId, userId } from "../../src/lib/id"

/**
 * `recordSteps` against a claim with no `agent_sessions` row, on the real
 * schema. Two ways there: session-control claims never insert one, or a
 * second claim on a stream with a RUNNING session skips the insert on
 * conflict. Either way `appendStep` would only die on "row not found" — a
 * logged 500, acked INTERNAL_ERROR — so the op must reject up front instead.
 */
describe("recordSteps against a claim with no agent session", () => {
  let pool: Pool
  const ws = workspaceId()
  const botId = `bot_${Math.random().toString(36).slice(2, 10)}`
  const instanceId = "steps-guard-test"
  const stream = streamId()
  const author = userId()

  beforeAll(async () => {
    pool = await setupTestDatabase()
    // The happy-path case runs the production authority gate, which locks the
    // stream and requires a real grant for the bot principal — so the rows it
    // reads have to exist, not just the invocation.
    await pool.query("INSERT INTO workspaces (id, name, slug, created_by) VALUES ($1, 'Steps guard', $2, $3)", [
      ws,
      `steps-guard-${ws.slice(-8)}`,
      author,
    ])
    await pool.query(
      "INSERT INTO streams (id, workspace_id, type, visibility, created_by) VALUES ($1,$2,'channel','private',$3)",
      [stream, ws, author]
    )
    await pool.query("INSERT INTO bots (id, workspace_id, api_key_id, name) VALUES ($1,$2,$3,'Steps guard bot')", [
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
  })

  afterAll(async () => {
    await pool.query("DELETE FROM bot_invocations WHERE workspace_id = $1", [ws])
    await pool.query(
      "DELETE FROM agent_session_steps WHERE session_id IN (SELECT id FROM agent_sessions WHERE stream_id = $1)",
      [stream]
    )
    await pool.query("DELETE FROM agent_sessions WHERE stream_id = $1", [stream])
    await pool.query("DELETE FROM bot_channel_access WHERE workspace_id = $1", [ws])
    await pool.query("DELETE FROM bots WHERE workspace_id = $1", [ws])
    await pool.query("DELETE FROM streams WHERE workspace_id = $1", [ws])
    await pool.query("DELETE FROM workspaces WHERE id = $1", [ws])
    await pool.end()
  })

  function ops() {
    return createBotRuntimeWriteOps({
      pool,
      io: { to: () => ({ emit: () => {} }) } as unknown as Server,
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
      } as unknown as BotRuntimeService,
      botChannelService: {
        isStreamAccessibleForBot: async () => true,
      } as unknown as BotChannelService,
    })
  }

  async function seedClaim(id: string, trigger: string, claimToken: string): Promise<void> {
    await BotInvocationRepository.insertIdempotent(pool, {
      id,
      workspaceId: ws,
      rootStreamId: stream,
      activeStreamId: stream,
      sourceMessageId: `msg_${id}`,
      responseStreamId: stream,
      actorType: "bot",
      actorId: botId,
      trigger,
      requiredCapability: "session-control",
      promptMarkdown: "/stop",
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
      [id, instanceId, claimToken]
    )
  }

  test("should reject with INVOCATION_SESSION_MISSING when the claim is session-control", async () => {
    await seedClaim("binv_sc_guard", "session-control", "tok_sc_guard")
    const error = await ops()
      .recordSteps({
        workspaceId: ws,
        botId,
        invocationId: "binv_sc_guard",
        instanceId,
        claimToken: "tok_sc_guard",
        steps: [{ stepType: "context_received", content: "Running /stop" }],
      })
      .then(
        () => null,
        (err: unknown) => err
      )
    expect(error).toBeInstanceOf(HttpError)
    expect({ status: (error as HttpError).status, code: (error as HttpError).code }).toEqual({
      status: 409,
      code: "INVOCATION_SESSION_MISSING",
    })
  })

  test("should reject with INVOCATION_SESSION_MISSING when another session was still running on the stream at claim time", async () => {
    await seedClaim("binv_sc_regular_a", "active-scratchpad", "tok_sc_regular_a")
    const inserted = await AgentSessionRepository.insertRunningOrSkip(pool, {
      id: "binv_sc_regular_a",
      streamId: stream,
      personaId: botId,
      triggerMessageId: "msg_binv_sc_regular_a",
      initialSequence: 0n,
    })
    expect(inserted).not.toBeNull()

    await seedClaim("binv_sc_regular_b", "active-scratchpad", "tok_sc_regular_b")
    const skipped = await AgentSessionRepository.insertRunningOrSkip(pool, {
      id: "binv_sc_regular_b",
      streamId: stream,
      personaId: botId,
      triggerMessageId: "msg_binv_sc_regular_b",
      initialSequence: 0n,
    })
    expect(skipped).toBeNull()

    const error = await ops()
      .recordSteps({
        workspaceId: ws,
        botId,
        invocationId: "binv_sc_regular_b",
        instanceId,
        claimToken: "tok_sc_regular_b",
        steps: [{ stepType: "thinking", content: "working" }],
      })
      .then(
        () => null,
        (err: unknown) => err
      )
    expect(error).toBeInstanceOf(HttpError)
    expect({ status: (error as HttpError).status, code: (error as HttpError).code }).toEqual({
      status: 409,
      code: "INVOCATION_SESSION_MISSING",
    })

    const result = await ops().recordSteps({
      workspaceId: ws,
      botId,
      invocationId: "binv_sc_regular_a",
      instanceId,
      claimToken: "tok_sc_regular_a",
      steps: [{ stepType: "thinking", content: "working" }],
    })
    expect(result.steps).toHaveLength(1)
    const persisted = await pool.query("SELECT step_type, content FROM agent_session_steps WHERE session_id = $1", [
      "binv_sc_regular_a",
    ])
    expect(persisted.rows).toEqual([{ step_type: "thinking", content: "working" }])
  })
})
