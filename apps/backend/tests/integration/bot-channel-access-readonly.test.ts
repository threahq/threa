import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { BotChannelAccessRepository } from "../../src/features/api-keys"
import { setupTestDatabase } from "./setup"

describe("BotChannelAccessRepository.filterGrantedStreamIds", () => {
  let pool: Pool
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10)
  const workspaceA = `ws_filter_a_${suffix}`
  const workspaceB = `ws_filter_b_${suffix}`
  const botA = `bot_filter_a_${suffix}`
  const botB = `bot_filter_b_${suffix}`
  const streamA = `stream_filter_a_${suffix}`
  const streamB = `stream_filter_b_${suffix}`
  const streamOtherWorkspace = `stream_filter_other_${suffix}`

  beforeAll(async () => {
    pool = await setupTestDatabase()
    await pool.query(
      `INSERT INTO workspaces (id, name, slug, created_by) VALUES
       ($1, 'Filter A', $2, 'usr_test'), ($3, 'Filter B', $4, 'usr_test')`,
      [workspaceA, `filter-a-${suffix}`, workspaceB, `filter-b-${suffix}`]
    )
    await pool.query(
      `INSERT INTO streams (id, workspace_id, type, visibility, created_by) VALUES
       ($1, $2, 'channel', 'private', 'usr_test'),
       ($3, $2, 'channel', 'private', 'usr_test'),
       ($4, $5, 'channel', 'private', 'usr_test')`,
      [streamA, workspaceA, streamB, streamOtherWorkspace, workspaceB]
    )
    await pool.query(
      `INSERT INTO bots (id, workspace_id, api_key_id, name) VALUES
       ($1, $2, $3, 'Bot A'), ($4, $2, $5, 'Bot B')`,
      [botA, workspaceA, `key_a_${suffix}`, botB, `key_b_${suffix}`]
    )
    await BotChannelAccessRepository.grantAccess(pool, {
      id: `bca_a_${suffix}`,
      workspaceId: workspaceA,
      botId: botA,
      streamId: streamA,
      grantedBy: "usr_test",
    })
    await BotChannelAccessRepository.grantAccess(pool, {
      id: `bca_b_${suffix}`,
      workspaceId: workspaceA,
      botId: botB,
      streamId: streamB,
      grantedBy: "usr_test",
    })
    await BotChannelAccessRepository.grantAccess(pool, {
      id: `bca_other_${suffix}`,
      workspaceId: workspaceB,
      botId: botA,
      streamId: streamOtherWorkspace,
      grantedBy: "usr_test",
    })
  })

  afterAll(async () => {
    await pool.query("DELETE FROM bot_channel_access WHERE workspace_id = ANY($1)", [[workspaceA, workspaceB]])
    await pool.query("DELETE FROM bots WHERE id = ANY($1)", [[botA, botB]])
    await pool.query("DELETE FROM streams WHERE workspace_id = ANY($1)", [[workspaceA, workspaceB]])
    await pool.query("DELETE FROM workspaces WHERE id = ANY($1)", [[workspaceA, workspaceB]])
    await pool.end()
  })

  test("returns only candidate grants matching bot and workspace scope", async () => {
    expect(
      await BotChannelAccessRepository.filterGrantedStreamIds(pool, workspaceA, botA, [
        streamB,
        streamA,
        streamOtherWorkspace,
        "stream_missing",
      ])
    ).toEqual(new Set([streamA]))
  })

  test("returns empty without querying candidates", async () => {
    expect(await BotChannelAccessRepository.filterGrantedStreamIds(pool, workspaceA, botA, [])).toEqual(new Set())
  })
})
