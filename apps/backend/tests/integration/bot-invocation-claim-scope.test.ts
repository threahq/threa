import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase } from "./setup"
import { BotInvocationRepository } from "../../src/features/bot-runtimes"
import { streamId, workspaceId, userId } from "../../src/lib/id"

/**
 * `claimOne`'s response-stream filter, against the real schema.
 *
 * A connector that folds several queued messages into one turn can only fold
 * messages sharing a response stream — the turn is delivered with one stream
 * id, so folding across streams answers one stream's question in another and
 * closes the rest unanswered. There is no way to release a claim, so the filter
 * has to keep the wrong invocation from being claimed at all rather than let
 * the client claim and inspect.
 */
describe("BotInvocationRepository.claimOne response-stream scope", () => {
  let pool: Pool
  const ws = workspaceId()
  const botId = `bot_${Math.random().toString(36).slice(2, 10)}`
  const instanceId = "cc-scope-test"
  const rootStream = streamId()
  const threadStream = streamId()
  const author = userId()

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.query("DELETE FROM bot_invocations WHERE workspace_id = $1", [ws])
    await pool.query("DELETE FROM bot_runtime_instances WHERE workspace_id = $1", [ws])
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query("DELETE FROM bot_invocations WHERE workspace_id = $1", [ws])
    await pool.query("DELETE FROM bot_runtime_instances WHERE workspace_id = $1", [ws])
    await pool.query(
      `INSERT INTO bot_runtime_instances (id, workspace_id, bot_id, instance_id, runtime_kind, status, accepting_invocations)
       VALUES ($1, $2, $3, $4, 'claude-code-channel', 'available', TRUE)`,
      [`bri_${instanceId}`, ws, botId, instanceId]
    )
  })

  async function seed(id: string, responseStreamId: string, sourceMessageId: string): Promise<void> {
    await BotInvocationRepository.insertIdempotent(pool, {
      id,
      workspaceId: ws,
      rootStreamId: rootStream,
      activeStreamId: responseStreamId,
      sourceMessageId,
      responseStreamId,
      actorType: "bot",
      actorId: botId,
      trigger: "active-scratchpad",
      requiredCapability: "active-scratchpad",
      promptMarkdown: `prompt for ${responseStreamId}`,
      authorUserId: author,
      mentionedActorSlugs: [],
      targetInstanceId: null,
      targetRuntimeSessionId: null,
      metadata: {},
    })
  }

  const claim = (responseStreamId?: string) =>
    BotInvocationRepository.claimOne(pool, {
      workspaceId: ws,
      botId,
      instanceId,
      runtimeKind: "claude-code-channel",
      claimToken: `tok_${Math.random().toString(36).slice(2)}`,
      supportedCapabilities: ["active-scratchpad"],
      claimTtlSeconds: 60,
      maxAttempts: 5,
      ...(responseStreamId ? { responseStreamId } : {}),
    })

  test("should persist the actual runtime session on every successful claim", async () => {
    await seed("binv_runtime_identity", rootStream, "msg_runtime_identity")

    const first = await BotInvocationRepository.claimOne(pool, {
      workspaceId: ws,
      botId,
      instanceId,
      runtimeSessionId: "rts_first",
      runtimeKind: "claude-code-channel",
      claimToken: "tok_first",
      supportedCapabilities: ["active-scratchpad"],
      claimTtlSeconds: 60,
      maxAttempts: 5,
    })
    await pool.query("UPDATE bot_invocations SET claim_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1", [
      "binv_runtime_identity",
    ])
    const reclaimed = await BotInvocationRepository.claimOne(pool, {
      workspaceId: ws,
      botId,
      instanceId,
      runtimeSessionId: "rts_replacement",
      runtimeKind: "claude-code-channel",
      claimToken: "tok_replacement",
      supportedCapabilities: ["active-scratchpad"],
      claimTtlSeconds: 60,
      maxAttempts: 5,
    })
    const persisted = await pool.query<{
      claimed_runtime_session_id: string | null
      claimed_runtime_session_claim_token: string | null
    }>("SELECT claimed_runtime_session_id, claimed_runtime_session_claim_token FROM bot_invocations WHERE id = $1", [
      "binv_runtime_identity",
    ])

    expect({
      first: {
        runtimeSessionId: first?.claimedRuntimeSessionId,
        claimToken: first?.claimedRuntimeSessionClaimToken,
      },
      reclaimed: {
        runtimeSessionId: reclaimed?.claimedRuntimeSessionId,
        claimToken: reclaimed?.claimedRuntimeSessionClaimToken,
      },
      persisted: {
        runtimeSessionId: persisted.rows[0]?.claimed_runtime_session_id,
        claimToken: persisted.rows[0]?.claimed_runtime_session_claim_token,
      },
    }).toEqual({
      first: { runtimeSessionId: "rts_first", claimToken: "tok_first" },
      reclaimed: { runtimeSessionId: "rts_replacement", claimToken: "tok_replacement" },
      persisted: { runtimeSessionId: "rts_replacement", claimToken: "tok_replacement" },
    })
  })

  test("should leave the new runtime binding stale when an old writer reclaims the row", async () => {
    await seed("binv_old_writer", rootStream, "msg_old_writer")
    await BotInvocationRepository.claimOne(pool, {
      workspaceId: ws,
      botId,
      instanceId,
      runtimeSessionId: "rts_new_writer",
      runtimeKind: "claude-code-channel",
      claimToken: "tok_new_writer",
      supportedCapabilities: ["active-scratchpad"],
      claimTtlSeconds: 60,
      maxAttempts: 5,
    })

    await pool.query(
      `UPDATE bot_invocations
       SET status='claimed', claimed_by_instance_id=$2, claim_token=$3,
           claim_expires_at=NOW()+INTERVAL '60 seconds'
       WHERE id=$1`,
      ["binv_old_writer", instanceId, "tok_old_writer"]
    )
    const row = await pool.query<{
      claim_token: string
      claimed_runtime_session_id: string | null
      claimed_runtime_session_claim_token: string | null
    }>(
      `SELECT claim_token, claimed_runtime_session_id, claimed_runtime_session_claim_token
       FROM bot_invocations WHERE id=$1`,
      ["binv_old_writer"]
    )

    expect(row.rows[0]).toEqual({
      claim_token: "tok_old_writer",
      claimed_runtime_session_id: "rts_new_writer",
      claimed_runtime_session_claim_token: "tok_new_writer",
    })
  })

  test("a scoped claim skips a FIFO-earlier invocation belonging to another stream", async () => {
    await seed("binv_thread_first", threadStream, "msg_thread")
    await seed("binv_root_second", rootStream, "msg_root")

    const scoped = await claim(rootStream)

    expect(scoped?.id).toBe("binv_root_second")
    expect(scoped?.responseStreamId).toBe(rootStream)
    // The thread's invocation is untouched — still claimable in its own stream.
    const remaining = await claim(threadStream)
    expect(remaining?.id).toBe("binv_thread_first")
  })

  test("an unscoped claim is unchanged: strict FIFO across streams", async () => {
    await seed("binv_thread_first", threadStream, "msg_thread")
    await seed("binv_root_second", rootStream, "msg_root")

    expect((await claim())?.id).toBe("binv_thread_first")
  })

  test("a scope with nothing queued for it claims nothing rather than falling back", async () => {
    await seed("binv_thread_only", threadStream, "msg_thread")

    expect(await claim(rootStream)).toBeNull()
    expect((await claim(threadStream))?.id).toBe("binv_thread_only")
  })
})
