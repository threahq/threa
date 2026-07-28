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
