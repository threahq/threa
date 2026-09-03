import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import type { Pool } from "pg"
import { setupIsolatedTestDatabase } from "./setup"
import { AgentSessionRepository } from "../../src/features/agents"
import { BotRuntimeService } from "../../src/features/bot-runtimes"

const MIGRATION_PATH = resolve(
  import.meta.dir,
  "../../src/db/migrations/20260903090000_bot_invocation_source_revisions.sql"
)

describe("bot invocation source revisions migration", () => {
  let pool: Pool
  let cleanup: () => Promise<void>
  let migrationSql: string

  beforeAll(async () => {
    const isolated = await setupIsolatedTestDatabase("invocation_revisions")
    pool = isolated.pool
    cleanup = isolated.cleanup
    migrationSql = await Bun.file(MIGRATION_PATH).text()

    await pool.query(`
      DROP INDEX idx_bot_invocations_active_source_actor_trigger;
      ALTER TABLE bot_invocations
        DROP COLUMN source_message_revision,
        DROP COLUMN claimed_source_message_revision,
        DROP COLUMN claimed_input_update_mode,
        DROP COLUMN cancellation_reason,
        DROP COLUMN available_at;
      ALTER TABLE bot_invocations
        ADD CONSTRAINT bot_invocations_workspace_id_source_message_id_actor_type_a_key
        UNIQUE (workspace_id, source_message_id, actor_type, actor_id, trigger);
    `)
  }, 30_000)

  afterAll(async () => cleanup?.())

  // messages.revision is already backfilled by 20260821120000_messages_revision.sql
  // (MAX(version_number) + 1); the seeded revisions reproduce that state.
  test("bumps tombstones, backfills live claims, and cancels deleted-source invocations from the artifact", async () => {
    await pool.query(
      `INSERT INTO streams (id, workspace_id, type, visibility, created_by)
       VALUES ('stream_migration', 'ws_migration', 'scratchpad', 'private', 'usr_1')`
    )
    await pool.query(
      `INSERT INTO messages
         (id, stream_id, sequence, author_id, author_type, content_json, content_markdown, revision, deleted_at)
       VALUES
         ('msg_initial', 'stream_migration', 1, 'usr_1', 'user', '{"type":"doc"}', 'initial', 1, NULL),
         ('msg_edited', 'stream_migration', 2, 'usr_1', 'user', '{"type":"doc"}', 'third', 3, NULL),
         ('msg_deleted', 'stream_migration', 3, 'usr_1', 'user', '{"type":"doc"}', 'gone', 2, NOW())`
    )
    await pool.query(
      `INSERT INTO message_versions
         (id, message_id, version_number, content_json, content_markdown, edited_by)
       VALUES
         ('mver_1', 'msg_edited', 1, '{"type":"doc"}', 'initial', 'usr_1'),
         ('mver_2', 'msg_edited', 2, '{"type":"doc"}', 'second', 'usr_1'),
         ('mver_deleted', 'msg_deleted', 1, '{"type":"doc"}', 'before deletion', 'usr_1')`
    )
    await pool.query(
      `INSERT INTO bot_invocations
         (id, workspace_id, root_stream_id, active_stream_id, source_message_id, response_stream_id,
          actor_type, actor_id, trigger, required_capability, prompt_markdown, author_user_id, status)
       VALUES
         ('binv_live', 'ws_migration', 'stream_migration', 'stream_migration', 'msg_edited',
          'stream_migration', 'bot', 'bot_1', 'active-scratchpad', 'active-scratchpad', 'third', 'usr_1', 'claimed'),
         ('binv_deleted', 'ws_migration', 'stream_migration', 'stream_migration', 'msg_deleted',
          'stream_migration', 'bot', 'bot_1', 'mention', 'mentionable', 'gone', 'usr_1', 'claimed')`
    )
    await AgentSessionRepository.insertRunningOrSkip(pool, {
      id: "binv_deleted",
      streamId: "stream_migration",
      personaId: "bot_1",
      triggerMessageId: "msg_deleted",
      initialSequence: 0n,
    })

    await pool.query(migrationSql)
    const repairedSources = await new BotRuntimeService({ pool }).repairDeletedSourceSessions()

    const messages = await pool.query<{ id: string; revision: number }>(
      `SELECT id, revision FROM messages WHERE stream_id = 'stream_migration' ORDER BY id`
    )
    const invocations = await pool.query<{
      id: string
      source_message_revision: number
      claimed_source_message_revision: number | null
      status: string
      cancellation_reason: string | null
    }>(
      `SELECT id, source_message_revision, claimed_source_message_revision, status, cancellation_reason
       FROM bot_invocations WHERE workspace_id = 'ws_migration' ORDER BY id`
    )

    const repairedSession = await pool.query<{ status: string; error: string; completed_at: Date | null }>(
      "SELECT status, error, completed_at FROM agent_sessions WHERE id = 'binv_deleted'"
    )
    const lifecycleOutbox = await pool.query<{ session_id: string }>(
      `SELECT payload #>> '{event,payload,sessionId}' AS session_id
       FROM outbox
       WHERE event_type = 'agent_session:deleted'
         AND payload->>'workspaceId' = 'ws_migration'`
    )

    expect(repairedSources).toBe(1)
    expect(messages.rows).toEqual([
      { id: "msg_deleted", revision: 3 },
      { id: "msg_edited", revision: 3 },
      { id: "msg_initial", revision: 1 },
    ])
    expect(invocations.rows).toEqual([
      {
        id: "binv_deleted",
        source_message_revision: 3,
        claimed_source_message_revision: null,
        status: "cancelled",
        cancellation_reason: "source_deleted",
      },
      {
        id: "binv_live",
        source_message_revision: 3,
        claimed_source_message_revision: 3,
        status: "claimed",
        cancellation_reason: null,
      },
    ])
    expect(repairedSession.rows[0]).toEqual({
      status: "deleted",
      error: "Invocation source deleted",
      completed_at: expect.any(Date),
    })
    expect(lifecycleOutbox.rows).toEqual([{ session_id: "binv_deleted" }])

    // Rolling-deploy race: an old replica can insert the session after the new
    // replica's startup scan. Its agent_session:started event drives this
    // targeted, invocation-PK repair path.
    await pool.query(
      `INSERT INTO bot_invocations
         (id, workspace_id, root_stream_id, active_stream_id, source_message_id, response_stream_id,
          actor_type, actor_id, trigger, required_capability, prompt_markdown, source_message_revision,
          author_user_id, status, cancellation_reason)
       VALUES
         ('binv_late', 'ws_migration', 'stream_migration', 'stream_migration', 'msg_deleted',
          'stream_migration', 'bot', 'bot_2', 'mention', 'mentionable', 'gone', 3,
          'usr_1', 'cancelled', 'source_deleted')`
    )
    await AgentSessionRepository.insertRunningOrSkip(pool, {
      id: "binv_late",
      streamId: "stream_migration",
      personaId: "bot_2",
      triggerMessageId: "msg_deleted",
      initialSequence: 0n,
    })
    expect(
      await new BotRuntimeService({ pool }).repairDeletedSourceSession({
        workspaceId: "ws_migration",
        sessionId: "binv_late",
      })
    ).toBe(true)
    const lateSession = await pool.query<{ status: string }>("SELECT status FROM agent_sessions WHERE id = 'binv_late'")
    expect(lateSession.rows).toEqual([{ status: "deleted" }])
  }, 30_000)
})
