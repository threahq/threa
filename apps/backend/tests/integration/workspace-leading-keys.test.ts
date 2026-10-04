import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import type { Pool } from "pg"
import { setupIsolatedTestDatabase } from "./setup"

/** Old key names that already have a workspace-leading `<name>_ws` twin. */
const TWINNED_KEYS: string[] = [
  "streams_pkey",
  "idx_streams_thread_anchor_typed",
  "stream_events_pkey",
  "stream_events_stream_id_sequence_key",
  "idx_stream_events_stream_broadcast_seq",
  "stream_members_pkey",
  "stream_sequences_pkey",
  "stream_policies_pkey",
  "idx_stream_briefs_stream",
  "users_pkey",
  "idx_sca_stream_intent_unique",
  "stream_persona_participants_pkey",
  "stream_persona_roster_pkey",
  "e2e_streams_pkey",
  "idx_agent_conversation_summaries_stream_persona",
  "idx_agent_sessions_one_running_per_stream",
  "idx_subagent_runs_one_active",
  "messages_pkey",
  "messages_stream_id_client_message_id_unique",
  "message_versions_pkey",
  "idx_message_versions_message_seq",
  "message_compose_traces_pkey",
  "message_conversation_state_pkey",
  "reactions_pkey",
  "researcher_cache_message_id_key",
  "conversations_pkey",
  "memos_pkey",
  "link_previews_pkey",
  "attachments_pkey",
  "attachment_references_pkey",
  "attachment_references_pair_idx",
  "attachment_extractions_pkey",
  "attachment_extractions_attachment_id_key",
  "attachment_uploads_attachment_id_key",
  "pdf_page_extractions_pkey",
  "pdf_page_extractions_attachment_id_page_number_key",
  "pdf_processing_jobs_attachment_id_key",
  "video_transcode_jobs_attachment_id_key",
  "persona_attachments_pkey",
]

/** Unique keys that need no twin of their own, each with its reason. */
const EXEMPT_KEYS: Record<string, string> = {
  access_log_pkey: "partition key carries occurred_at; ids are generated locally (accessLogId)",
  agent_session_steps_client_step_id_key: "keyed by session id; sessions are created locally, never copied",
  agent_session_steps_session_id_step_number_key: "keyed by session id; sessions are created locally, never copied",
  command_dispatches_pkey: "command ids are generated per dispatch in this workspace (generateCommandId)",
  unique_schedule_execution: "keyed by schedule id; schedules are workspace-local or system-wide, never copied",
  push_deliveries_plan_id_subscription_id_key:
    "plan ids are generated per fan-out (pushDeliveryPlanId); subscriptions are workspace-local",
  idx_push_receipts_token_hash: "hash of a random receipt token minted per delivery (newReceiptToken)",
  sandbox_session_tokens_hash_idx:
    "hash of a random session token; looked up by hash alone before the workspace is known",
  idx_user_api_keys_hash: "hash of a random key minted locally (randomBytes); the key identifies its workspace",
  idx_workspace_invitations_token_hash:
    "hash of a random invitation token; looked up by hash alone before the workspace is known",
  idx_sync_log_outbox_event: "outbox event ids come from one global BIGINT sequence",
  idx_workspace_invitations_parent_email: "parent_link_id is an invitation id generated in this workspace",
  users_id_key: "same (id) columns as users_pkey, so users_pkey_ws already covers it",
  backfill_runs_backfill_name_workspace_id_key: "code-defined backfill name plus workspace_id; no copied id in the key",
  cron_schedules_queue_workspace_key:
    "code-defined queue name plus workspace_id (NULL when system-wide); no copied id in the key",
}

/** Keys later W3 steps twin; each step deletes its entries and the last one deletes the list. */
const NOT_YET_TWINNED: string[] = [
  "stream_read_state_pkey",
  "stream_member_message_reads_pkey",
  "board_hidden_conversations_pkey",
  "board_muted_streams_pkey",
  "idx_user_activity_dedup_non_reaction",
  "idx_user_activity_dedup_reaction",
  "user_preference_overrides_pkey",
]

const MIGRATIONS_DIR = path.resolve(import.meta.dir, "../../src/db/migrations")
const STREAM_MEMBERS_MIGRATION_SUFFIX = "_workspace_leading_keys_stream_members.sql"

interface TwinShape {
  oldPresent: boolean
  twin: string | null
  valid: boolean
}

describe("workspace-leading twin keys", () => {
  let pool: Pool
  let cleanup: () => Promise<void>

  beforeAll(async () => {
    const isolated = await setupIsolatedTestDatabase("workspace_leading_keys")
    pool = isolated.pool
    cleanup = isolated.cleanup
  }, 30_000)

  afterAll(async () => {
    await cleanup()
  }, 30_000)

  test("should lead every twin with workspace_id and keep the old definition when a key is twinned", async () => {
    const result = await pool.query<{ name: string; def: string; valid: boolean }>(
      `
      SELECT i.relname AS name, pg_get_indexdef(i.oid) AS def, ix.indisvalid AS valid
      FROM pg_class i
      JOIN pg_index ix ON ix.indexrelid = i.oid
      JOIN pg_namespace n ON n.oid = i.relnamespace
      WHERE n.nspname = 'public' AND i.relname = ANY($1)
    `,
      [TWINNED_KEYS.flatMap((name) => [name, `${name}_ws`])]
    )
    const byName = new Map(result.rows.map((row) => [row.name, row]))

    const actual: Record<string, TwinShape> = {}
    const expected: Record<string, TwinShape> = {}
    for (const name of TWINNED_KEYS) {
      const old = byName.get(name)
      const twin = byName.get(`${name}_ws`)
      actual[name] = { oldPresent: old !== undefined, twin: twin?.def ?? null, valid: twin?.valid ?? false }
      expected[name] = {
        oldPresent: true,
        twin:
          old?.def
            .replace(`INDEX ${name} ON`, `INDEX ${name}_ws ON`)
            .replace("USING btree (", "USING btree (workspace_id, ") ?? null,
        valid: true,
      }
    }

    expect(actual).toEqual(expected)
  })

  test("should list every non-workspace-leading unique key in exactly one list when a table carries workspace_id", async () => {
    const result = await pool.query<{ name: string; skipped: boolean }>(`
      -- Plain (id) primary keys are mostly locally generated ids; copied tables list theirs by hand.
      SELECT i.relname AS name,
             (ix.indkey[0] = wa.attnum)
               OR (ix.indisprimary AND ix.indnkeyatts = 1 AND fa.attname = 'id') AS skipped
      FROM pg_index ix
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_class c ON c.oid = ix.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute wa ON wa.attrelid = c.oid AND wa.attname = 'workspace_id' AND NOT wa.attisdropped
      LEFT JOIN pg_attribute fa ON fa.attrelid = c.oid AND fa.attnum = ix.indkey[0]
      WHERE ix.indisunique AND n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
    `)
    const existing = new Set(result.rows.map((row) => row.name))
    const lists: Record<string, Set<string>> = {
      TWINNED_KEYS: new Set(TWINNED_KEYS),
      EXEMPT_KEYS: new Set(Object.keys(EXEMPT_KEYS)),
      NOT_YET_TWINNED: new Set(NOT_YET_TWINNED),
    }
    const listsNaming = (name: string) =>
      Object.entries(lists)
        .filter(([, names]) => names.has(name))
        .map(([list]) => list)

    const violations = [
      ...result.rows
        .filter((row) => !row.skipped && listsNaming(row.name).length === 0)
        .map((row) => ({ key: row.name, problem: "leads without workspace_id and is in no list" })),
      ...[...new Set(Object.values(lists).flatMap((names) => [...names]))].flatMap((name) => {
        const named = listsNaming(name)
        return [
          ...(existing.has(name) ? [] : [{ key: name, problem: "listed but no such unique key exists" }]),
          ...(named.length > 1 ? [{ key: name, problem: `listed in ${named.join(" and ")}` }] : []),
        ]
      }),
    ]

    expect(violations).toEqual([])
  })

  test("should open every twin migration with SET LOCAL lock_timeout when it builds its index under a table lock", () => {
    const openingLines = Object.fromEntries(
      readdirSync(MIGRATIONS_DIR)
        .filter((file) => file.includes("_workspace_leading_keys_"))
        .map((file) => [file, readFileSync(path.join(MIGRATIONS_DIR, file), "utf8").split("\n")[0]])
    )

    expect(openingLines).toEqual(
      Object.fromEntries(Object.keys(openingLines).map((file) => [file, "SET LOCAL lock_timeout = '5s';"]))
    )
  })

  test("should abort the migration with a lock timeout when the table is locked and leave the session setting untouched", async () => {
    const migrationFile = readdirSync(MIGRATIONS_DIR).find((file) => file.endsWith(STREAM_MEMBERS_MIGRATION_SUFFIX))
    expect(migrationFile).toBeDefined()
    const migrationSql = readFileSync(path.join(MIGRATIONS_DIR, migrationFile!), "utf8")
    await pool.query("DROP INDEX stream_members_pkey_ws")

    const holder = await pool.connect()
    const migrator = await pool.connect()
    let holding = false
    try {
      await holder.query("BEGIN")
      holding = true
      await holder.query("LOCK TABLE stream_members IN ROW EXCLUSIVE MODE")

      await migrator.query("SET statement_timeout = '20s'")
      const before = (await migrator.query<{ lock_timeout: string }>("SHOW lock_timeout")).rows[0].lock_timeout
      const startedAt = Date.now()
      const failure = await migrator.query(migrationSql).then(
        () => null,
        (error: { code?: string }) => error
      )
      const elapsedMs = Date.now() - startedAt

      expect({
        sqlstate: failure?.code,
        waitedAboutTheLockTimeout: elapsedMs >= 4_500 && elapsedMs < 15_000,
      }).toEqual({
        sqlstate: "55P03",
        waitedAboutTheLockTimeout: true,
      })

      await holder.query("ROLLBACK")
      holding = false
      await migrator.query(migrationSql)

      const twin = await pool.query<{ indisvalid: boolean }>(
        `SELECT ix.indisvalid FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid WHERE i.relname = 'stream_members_pkey_ws'`
      )
      const after = (await migrator.query<{ lock_timeout: string }>("SHOW lock_timeout")).rows[0].lock_timeout
      expect({ twin: twin.rows, lockTimeout: after }).toEqual({ twin: [{ indisvalid: true }], lockTimeout: before })
    } finally {
      if (holding) await holder.query("ROLLBACK").catch(() => undefined)
      holder.release()
      migrator.release()
    }
  }, 30_000)
})
