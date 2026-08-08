import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import type { Pool } from "pg"
import { setupIsolatedTestDatabase } from "./setup"

const MIGRATION_PATH = resolve(
  import.meta.dir,
  "../../src/db/migrations/20260808073545_bot_invocation_source_revisions.sql"
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
      ALTER TABLE messages DROP COLUMN revision;
    `)
  })

  afterAll(async () => cleanup())

  test("backfills initial and edited messages, live claims, and deleted-source cancellation from the artifact", async () => {
    await pool.query(
      `INSERT INTO streams (id, workspace_id, type, visibility, created_by)
       VALUES ('stream_migration', 'ws_migration', 'scratchpad', 'private', 'usr_1')`
    )
    await pool.query(
      `INSERT INTO messages
         (id, stream_id, sequence, author_id, author_type, content_json, content_markdown, deleted_at)
       VALUES
         ('msg_initial', 'stream_migration', 1, 'usr_1', 'user', '{"type":"doc"}', 'initial', NULL),
         ('msg_edited', 'stream_migration', 2, 'usr_1', 'user', '{"type":"doc"}', 'third', NULL),
         ('msg_deleted', 'stream_migration', 3, 'usr_1', 'user', '{"type":"doc"}', 'gone', NOW())`
    )
    await pool.query(
      `INSERT INTO message_versions
         (id, message_id, version_number, content_json, content_markdown, edited_by)
       VALUES
         ('mver_1', 'msg_edited', 1, '{"type":"doc"}', 'initial', 'usr_1'),
         ('mver_2', 'msg_edited', 2, '{"type":"doc"}', 'second', 'usr_1')`
    )
    await pool.query(
      `INSERT INTO bot_invocations
         (id, workspace_id, root_stream_id, active_stream_id, source_message_id, response_stream_id,
          actor_type, actor_id, trigger, required_capability, prompt_markdown, author_user_id, status)
       VALUES
         ('binv_live', 'ws_migration', 'stream_migration', 'stream_migration', 'msg_edited',
          'stream_migration', 'bot', 'bot_1', 'active-scratchpad', 'active-scratchpad', 'third', 'usr_1', 'claimed'),
         ('binv_deleted', 'ws_migration', 'stream_migration', 'stream_migration', 'msg_deleted',
          'stream_migration', 'bot', 'bot_1', 'mention', 'mentionable', 'gone', 'usr_1', 'pending')`
    )

    await pool.query(migrationSql)

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

    expect(messages.rows).toEqual([
      { id: "msg_deleted", revision: 1 },
      { id: "msg_edited", revision: 3 },
      { id: "msg_initial", revision: 1 },
    ])
    expect(invocations.rows).toEqual([
      {
        id: "binv_deleted",
        source_message_revision: 1,
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
  })
})
