import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase } from "./setup"
import { AgentSessionRepository, SessionStatuses } from "../../src/features/agents"
import { BotInvocationRepository } from "../../src/features/bot-runtimes"
import { messageId, streamId, userId, workspaceId } from "../../src/lib/id"

/**
 * A bot invocation's session shares its id, and claim renewal is the runtime's
 * liveness signal: a stale heartbeat under a live lease is not an orphan.
 */
describe("AgentSessionRepository.findOrphaned with a live claim lease", () => {
  let pool: Pool
  const ws = workspaceId()
  const botId = `bot_${Math.random().toString(36).slice(2, 10)}`
  const instanceId = "cc-lease-test"
  const stream = streamId()
  const author = userId()

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.query("DELETE FROM bot_invocations WHERE workspace_id = $1", [ws])
    await pool.query("DELETE FROM bot_runtime_instances WHERE workspace_id = $1", [ws])
    await pool.query("DELETE FROM agent_sessions WHERE stream_id = $1", [stream])
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query("DELETE FROM bot_invocations WHERE workspace_id = $1", [ws])
    await pool.query("DELETE FROM bot_runtime_instances WHERE workspace_id = $1", [ws])
    await pool.query("DELETE FROM agent_sessions WHERE stream_id = $1", [stream])
    await pool.query(
      `INSERT INTO bot_runtime_instances (id, workspace_id, bot_id, instance_id, runtime_kind, status, accepting_invocations)
       VALUES ($1, $2, $3, $4, 'claude-code-channel', 'available', TRUE)`,
      [`bri_${instanceId}`, ws, botId, instanceId]
    )
  })

  async function seedClaimedInvocation(id: string): Promise<void> {
    await BotInvocationRepository.insertIdempotent(pool, {
      id,
      workspaceId: ws,
      rootStreamId: stream,
      activeStreamId: stream,
      sourceMessageId: messageId(),
      responseStreamId: stream,
      actorType: "bot",
      actorId: botId,
      trigger: "active-scratchpad",
      requiredCapability: "active-scratchpad",
      promptMarkdown: "prompt",
      sourceMessageRevision: 0,
      authorUserId: author,
      mentionedActorSlugs: [],
      targetInstanceId: null,
      targetRuntimeSessionId: null,
      metadata: {},
    })
    const claimed = await BotInvocationRepository.claimOne(pool, {
      workspaceId: ws,
      botId,
      instanceId,
      runtimeKind: "claude-code-channel",
      claimToken: `tok_${Math.random().toString(36).slice(2)}`,
      supportedCapabilities: ["active-scratchpad"],
      claimTtlSeconds: 120,
      maxAttempts: 5,
    })
    expect(claimed?.id).toBe(id)
  }

  async function seedStaleRunningSession(id: string): Promise<void> {
    await AgentSessionRepository.insert(pool, {
      id,
      streamId: stream,
      personaId: botId,
      triggerMessageId: messageId(),
      status: SessionStatuses.RUNNING,
      serverId: null,
    })
    await pool.query("UPDATE agent_sessions SET heartbeat_at = NOW() - INTERVAL '5 minutes' WHERE id = $1", [id])
  }

  test("skips a stale session while its invocation claim lease is live", async () => {
    const id = `binv_lease_${Math.random().toString(36).slice(2, 10)}`
    await seedClaimedInvocation(id)
    await seedStaleRunningSession(id)

    expect((await AgentSessionRepository.findOrphaned(pool, 60)).map((s) => s.id)).toEqual([])
  })

  test("returns the session once the lease has expired", async () => {
    const id = `binv_lease_${Math.random().toString(36).slice(2, 10)}`
    await seedClaimedInvocation(id)
    await seedStaleRunningSession(id)
    await pool.query("UPDATE bot_invocations SET claim_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1", [id])

    expect((await AgentSessionRepository.findOrphaned(pool, 60)).map((s) => s.id)).toEqual([id])
  })

  test("returns a stale session with no invocation behind it", async () => {
    const id = `binv_lease_${Math.random().toString(36).slice(2, 10)}`
    await seedStaleRunningSession(id)

    expect((await AgentSessionRepository.findOrphaned(pool, 60)).map((s) => s.id)).toEqual([id])
  })
})
