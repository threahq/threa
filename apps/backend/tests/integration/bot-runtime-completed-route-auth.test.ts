import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { Pool } from "pg"
import { BotRuntimeSessionLinkRepository } from "../../src/features/bot-runtimes"
import { streamId, workspaceId } from "../../src/lib/id"
import { setupTestDatabase } from "./setup"

describe("completed bot invocation runtime-link authorization", () => {
  let pool: Pool
  const ws = workspaceId()
  const botId = `bot_${Math.random().toString(36).slice(2, 10)}`
  const linkedRootStreamId = streamId()
  const linkedActiveStreamId = streamId()
  const instanceId = "inst_completed_route"
  const runtimeSessionId = "rts_completed_route"
  const linkId = `brsl_${Math.random().toString(36).slice(2, 10)}`

  const authParams = { workspaceId: ws, botId, instanceId, runtimeSessionId }

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.query("DELETE FROM bot_runtime_session_links WHERE workspace_id = $1", [ws])
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query("DELETE FROM bot_runtime_session_links WHERE workspace_id = $1", [ws])
    await pool.query(
      `INSERT INTO bot_runtime_session_links
        (id, workspace_id, bot_id, runtime_kind, instance_id, runtime_session_id,
         root_stream_id, active_stream_id, status, linked_by)
       VALUES ($1, $2, $3, 'claude-code-channel', $4, $5, $6, $7, 'active', 'usr_test')`,
      [linkId, ws, botId, instanceId, runtimeSessionId, linkedRootStreamId, linkedActiveStreamId]
    )
  })

  test("should authorize the exact active runtime identity independent of its linked streams", async () => {
    const link = await BotRuntimeSessionLinkRepository.findActiveByRuntimeSessionForShare(pool, authParams)

    expect(link).toMatchObject({
      workspaceId: ws,
      botId,
      rootStreamId: linkedRootStreamId,
      activeStreamId: linkedActiveStreamId,
      instanceId,
      runtimeSessionId,
      status: "active",
    })
  })

  test("should reject a wrong workspace, bot, instance, or runtime session", async () => {
    const attempts = [
      { ...authParams, workspaceId: workspaceId() },
      { ...authParams, botId: "bot_wrong" },
      { ...authParams, instanceId: "inst_wrong" },
      { ...authParams, runtimeSessionId: "rts_wrong" },
    ]

    for (const params of attempts) {
      expect(await BotRuntimeSessionLinkRepository.findActiveByRuntimeSessionForShare(pool, params)).toBeNull()
    }
  })

  test.each([
    ["archived", "archived"],
    ["ended", "ended"],
  ] as const)("should reject an %s link", async (_label, status) => {
    await pool.query("UPDATE bot_runtime_session_links SET status = $1 WHERE workspace_id = $2", [status, ws])

    expect(await BotRuntimeSessionLinkRepository.findActiveByRuntimeSessionForShare(pool, authParams)).toBeNull()
  })

  test("should reject a replaced identity while accepting the replacement", async () => {
    await pool.query(
      `UPDATE bot_runtime_session_links
       SET instance_id = 'inst_replacement', runtime_session_id = 'rts_replacement'
       WHERE workspace_id = $1`,
      [ws]
    )

    expect(await BotRuntimeSessionLinkRepository.findActiveByRuntimeSessionForShare(pool, authParams)).toBeNull()
    expect(
      await BotRuntimeSessionLinkRepository.findActiveByRuntimeSessionForShare(pool, {
        ...authParams,
        instanceId: "inst_replacement",
        runtimeSessionId: "rts_replacement",
      })
    ).toMatchObject({ instanceId: "inst_replacement", runtimeSessionId: "rts_replacement" })
  })

  test("should hold the active-link authorization until its transaction commits", async () => {
    const holder = await pool.connect()
    const archiver = await pool.connect()
    try {
      await holder.query("BEGIN")
      await BotRuntimeSessionLinkRepository.findActiveByRuntimeSessionForShare(holder, authParams)

      await archiver.query("BEGIN")
      await archiver.query("SET LOCAL lock_timeout = '100ms'")
      const error = await archiver
        .query("UPDATE bot_runtime_session_links SET status = 'archived' WHERE id = $1", [linkId])
        .then(
          () => null,
          (caught: unknown) => caught
        )

      expect(error).toMatchObject({ code: "55P03" })
    } finally {
      await archiver.query("ROLLBACK")
      await holder.query("ROLLBACK")
      archiver.release()
      holder.release()
    }
  })
})
