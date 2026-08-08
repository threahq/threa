import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase } from "./setup"

const CLEANUP_MIGRATION = new URL(
  "../../src/db/migrations/20260808065950_remove_legacy_naming_compatibility.sql",
  import.meta.url
)
const DROP_TIMESTAMP_MIGRATION = new URL(
  "../../src/db/migrations/20260808080503_drop_stream_display_name_generated_at.sql",
  import.meta.url
)

describe("legacy naming cleanup migration", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  test("removes rollout triggers, queue work, and timestamp provenance", async () => {
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      await client.query(`
        INSERT INTO queue_messages (id, queue_name, workspace_id, payload, process_after, inserted_at)
        VALUES ('queue_legacy_naming_test', 'naming.generate', 'ws_test', '{}', NOW(), NOW())
      `)
      await client.query(`
        INSERT INTO queue_tokens (
          id, queue_name, workspace_id, leased_at, leased_by, leased_until, next_process_after, created_at
        ) VALUES (
          'token_legacy_naming_test', 'naming.generate', 'ws_test', NOW(), 'ticker_test', NOW(), NOW(), NOW()
        )
      `)

      await client.query(await Bun.file(CLEANUP_MIGRATION).text())
      await client.query("ALTER TABLE streams ADD COLUMN IF NOT EXISTS display_name_generated_at TIMESTAMPTZ")
      await client.query(await Bun.file(DROP_TIMESTAMP_MIGRATION).text())

      const message = await client.query(
        "SELECT cancelled_at, process_after, claimed_by FROM queue_messages WHERE id = 'queue_legacy_naming_test'"
      )
      const tokens = await client.query("SELECT id FROM queue_tokens WHERE id = 'token_legacy_naming_test'")
      const column = await client.query(`
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'streams' AND column_name = 'display_name_generated_at'
      `)
      const triggers = await client.query(`
        SELECT tgname FROM pg_trigger
        WHERE tgname LIKE 'preserve_legacy_%_title_intent_trigger'
          AND NOT tgisinternal
      `)

      expect({
        cancelled: message.rows[0]?.cancelled_at instanceof Date,
        processAfter: message.rows[0]?.process_after,
        claimedBy: message.rows[0]?.claimed_by,
        tokens: tokens.rowCount,
        legacyColumn: column.rowCount,
        triggers: triggers.rows,
      }).toEqual({
        cancelled: true,
        processAfter: null,
        claimedBy: null,
        tokens: 0,
        legacyColumn: 0,
        triggers: [],
      })
    } finally {
      await client.query("ROLLBACK")
      client.release()
    }
  })
})
