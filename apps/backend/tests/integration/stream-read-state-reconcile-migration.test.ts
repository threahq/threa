import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { resolve } from "node:path"
import { setupIsolatedTestDatabase, withTestTransaction } from "./setup"

const MIGRATION_PATH = resolve(
  import.meta.dir,
  "../../src/db/migrations/20260724190000_reconcile_stream_read_state.sql"
)

/**
 * The post-drain reconciliation (finding 100): PR 1's backfill copied every
 * membership watermark that existed when it ran, but old binaries still
 * draining afterwards wrote the membership column only. This migration folds
 * those late writes into stream_read_state with the same monotonic rule as
 * ReadStateRepository.advance — never regress a standalone frontier an
 * explicit unread may have moved down on purpose. Runs the real SQL against
 * Postgres: the sequence-resolution and strict-greater predicate can't be
 * proven from a mock.
 */
describe("reconcile stream_read_state migration", () => {
  let pool: Pool
  let cleanup: () => Promise<void>
  let migrationSql: string

  beforeAll(async () => {
    // Isolated DB: this migration reconciles columns the current branch still
    // carries (stream_members.last_read_event_id / last_read_at), which the
    // shared threa_test database may not — sibling stack branches migrate it
    // past the destructive cleanup that drops them.
    const isolated = await setupIsolatedTestDatabase("reconcile_read_state")
    pool = isolated.pool
    cleanup = isolated.cleanup
    migrationSql = await Bun.file(MIGRATION_PATH).text()
  })

  afterAll(async () => {
    await cleanup()
  })

  async function seedStream(client: import("pg").PoolClient, streamId: string, workspaceId: string): Promise<void> {
    await client.query(
      `INSERT INTO streams (id, workspace_id, type, visibility, created_by)
                        VALUES ($1, $2, 'channel', 'private', 'usr_seed')`,
      [streamId, workspaceId]
    )
  }

  async function seedEvent(
    client: import("pg").PoolClient,
    eventId: string,
    streamId: string,
    sequence: number
  ): Promise<void> {
    await client.query(
      `INSERT INTO stream_events (id, stream_id, sequence, event_type, payload)
       VALUES ($1, $2, $3, 'message_created', '{}'::jsonb)`,
      [eventId, streamId, sequence]
    )
  }

  async function seedMembershipWatermark(
    client: import("pg").PoolClient,
    streamId: string,
    userId: string,
    eventId: string | null,
    lastReadAt: string
  ): Promise<void> {
    await client.query(
      `INSERT INTO stream_members (stream_id, member_id, last_read_event_id, last_read_at)
       VALUES ($1, $2, $3, $4)`,
      [streamId, userId, eventId, lastReadAt]
    )
  }

  async function seedStandalone(
    client: import("pg").PoolClient,
    workspaceId: string,
    streamId: string,
    userId: string,
    eventId: string | null,
    lastReadAt: string | null
  ): Promise<void> {
    await client.query(
      `INSERT INTO stream_read_state (workspace_id, stream_id, user_id, last_read_event_id, last_read_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [workspaceId, streamId, userId, eventId, lastReadAt]
    )
  }

  async function readStandalone(
    client: import("pg").PoolClient,
    streamId: string,
    userId: string
  ): Promise<{ workspace_id: string; last_read_event_id: string | null; last_read_at: Date | null } | undefined> {
    const result = await client.query(
      `SELECT workspace_id, last_read_event_id, last_read_at
       FROM stream_read_state WHERE stream_id = $1 AND user_id = $2`,
      [streamId, userId]
    )
    return result.rows[0]
  }

  test("advances the standalone row when the membership watermark out-sequences it (E10 → E20)", async () => {
    await withTestTransaction(pool, async (client) => {
      await seedStream(client, "str_adv", "ws_recon")
      await seedEvent(client, "evt_10", "str_adv", 10)
      await seedEvent(client, "evt_20", "str_adv", 20)
      await seedStandalone(client, "ws_recon", "str_adv", "usr_adv", "evt_10", "2026-07-01T00:00:00Z")
      // The late old-binary write: membership moved past the backfilled row.
      await seedMembershipWatermark(client, "str_adv", "usr_adv", "evt_20", "2026-07-02T00:00:00Z")

      await client.query(migrationSql)

      const row = await readStandalone(client, "str_adv", "usr_adv")
      expect(row?.last_read_event_id).toBe("evt_20")
      // last_read_at carries over only when the membership frontier wins.
      expect(row?.last_read_at?.toISOString()).toBe("2026-07-02T00:00:00.000Z")
      expect(row?.workspace_id).toBe("ws_recon")
    })
  })

  test("never regresses a standalone row ahead of the membership watermark (E30 stays over E20)", async () => {
    await withTestTransaction(pool, async (client) => {
      await seedStream(client, "str_keep", "ws_recon")
      await seedEvent(client, "evt_20k", "str_keep", 20)
      await seedEvent(client, "evt_30", "str_keep", 30)
      // Standalone moved on (new binary) while the membership mirror lagged
      // — or an explicit unread parked the mirror below on purpose.
      await seedStandalone(client, "ws_recon", "str_keep", "usr_keep", "evt_30", "2026-07-03T00:00:00Z")
      await seedMembershipWatermark(client, "str_keep", "usr_keep", "evt_20k", "2026-07-02T00:00:00Z")

      await client.query(migrationSql)

      const row = await readStandalone(client, "str_keep", "usr_keep")
      expect(row?.last_read_event_id).toBe("evt_30")
      expect(row?.last_read_at?.toISOString()).toBe("2026-07-03T00:00:00.000Z")
    })
  })

  test("equal sequences do not advance (strictly greater only)", async () => {
    await withTestTransaction(pool, async (client) => {
      await seedStream(client, "str_eq", "ws_recon")
      await seedEvent(client, "evt_20e", "str_eq", 20)
      await seedStandalone(client, "ws_recon", "str_eq", "usr_eq", "evt_20e", "2026-07-03T00:00:00Z")
      await seedMembershipWatermark(client, "str_eq", "usr_eq", "evt_20e", "2026-07-02T00:00:00Z")

      await client.query(migrationSql)

      const row = await readStandalone(client, "str_eq", "usr_eq")
      expect(row?.last_read_event_id).toBe("evt_20e")
      // The standalone timestamp is untouched — the membership side didn't win.
      expect(row?.last_read_at?.toISOString()).toBe("2026-07-03T00:00:00.000Z")
    })
  })

  test("inserts missing rows for membership-only watermarks, workspace derived through streams", async () => {
    await withTestTransaction(pool, async (client) => {
      await seedStream(client, "str_ins", "ws_recon")
      await seedEvent(client, "evt_20i", "str_ins", 20)
      await seedMembershipWatermark(client, "str_ins", "usr_ins", "evt_20i", "2026-07-02T00:00:00Z")

      await client.query(migrationSql)

      const row = await readStandalone(client, "str_ins", "usr_ins")
      expect(row?.workspace_id).toBe("ws_recon")
      expect(row?.last_read_event_id).toBe("evt_20i")
      expect(row?.last_read_at?.toISOString()).toBe("2026-07-02T00:00:00.000Z")
    })
  })

  test("a NULL standalone watermark counts as sequence 0 — any membership event advances past it", async () => {
    await withTestTransaction(pool, async (client) => {
      await seedStream(client, "str_null", "ws_recon")
      await seedEvent(client, "evt_20n", "str_null", 20)
      // Explicit unread-to-zero: row present, watermark NULL.
      await seedStandalone(client, "ws_recon", "str_null", "usr_null", null, "2026-07-01T00:00:00Z")
      await seedMembershipWatermark(client, "str_null", "usr_null", "evt_20n", "2026-07-02T00:00:00Z")

      await client.query(migrationSql)

      const row = await readStandalone(client, "str_null", "usr_null")
      expect(row?.last_read_event_id).toBe("evt_20n")
    })
  })

  test("an unresolvable membership watermark (sequence 0) never advances a resolvable standalone row", async () => {
    await withTestTransaction(pool, async (client) => {
      await seedStream(client, "str_unres", "ws_recon")
      await seedEvent(client, "evt_10u", "str_unres", 10)
      await seedStandalone(client, "ws_recon", "str_unres", "usr_unres", "evt_10u", "2026-07-01T00:00:00Z")
      // Points at an event with no stream_events row (e.g. already pruned).
      await seedMembershipWatermark(client, "str_unres", "usr_unres", "evt_ghost", "2026-07-02T00:00:00Z")

      await client.query(migrationSql)

      const row = await readStandalone(client, "str_unres", "usr_unres")
      expect(row?.last_read_event_id).toBe("evt_10u")
      expect(row?.last_read_at?.toISOString()).toBe("2026-07-01T00:00:00.000Z")
    })
  })

  test("NULL membership watermarks are skipped — no row inserted for never-read members", async () => {
    await withTestTransaction(pool, async (client) => {
      await seedStream(client, "str_never", "ws_recon")
      await seedMembershipWatermark(client, "str_never", "usr_never", null, "2026-07-02T00:00:00Z")

      await client.query(migrationSql)

      expect(await readStandalone(client, "str_never", "usr_never")).toBeUndefined()
    })
  })
})
