import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { StubWorkosOrgService, type WorkosEvent } from "@threa/backend-common"
import { AuthLogPoller, AuthLogService } from "../../src/features/auth-log"
import { WorkosEventPollerLock } from "../../src/lib/workos-event-poller-lock"
import { setupTestDatabase } from "./setup"

describe("AuthLogPoller", () => {
  let pool: Pool
  const lockName = "test-auth-log-events-poller"
  const eventIds = ["event_al_01", "event_al_02", "event_al_03"]

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query("DELETE FROM workos_event_poller_state WHERE name = $1", [lockName])
    await pool.query("DELETE FROM auth_log WHERE workos_event_id = ANY($1)", [eventIds])
  })

  function rawEvent(id: string, type: string, data: Record<string, unknown>): WorkosEvent {
    return {
      id,
      event: type,
      createdAt: "2026-07-18T10:00:00.000Z",
      context: undefined,
      data,
    } as unknown as WorkosEvent
  }

  function makeStack({ batchSize = 10 }: { batchSize?: number } = {}) {
    const stub = new StubWorkosOrgService()
    const lock = new WorkosEventPollerLock({
      pool,
      name: lockName,
      lockDurationMs: 5_000,
      refreshIntervalMs: 1_000,
      maxRetries: 3,
      baseBackoffMs: 100,
    })
    const service = new AuthLogService({ pool })
    const poller = new AuthLogPoller({
      workosOrgService: stub,
      authLogService: service,
      lock,
      pollIntervalMs: 50,
      batchSize,
    })
    return { stub, lock, service, poller }
  }

  async function countRows(): Promise<number> {
    const res = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM auth_log WHERE workos_event_id = ANY($1)",
      [eventIds]
    )
    return Number(res.rows[0].count)
  }

  test("processes a page, advances cursor, and re-ingesting the same events inserts nothing new", async () => {
    const { stub, lock, poller } = makeStack({ batchSize: 2 })
    await lock.ensureRow()

    stub.pushEvent(rawEvent(eventIds[0], "authentication.password_failed", { email: "a@x.com", userId: "user_a" }))
    stub.pushEvent(
      rawEvent(eventIds[1], "session.created", {
        object: "session",
        userId: "user_b",
        impersonator: { email: "op@workos.com", reason: "debug" },
      })
    )
    stub.pushEvent(rawEvent(eventIds[2], "user.created", { object: "user", id: "user_c", email: "c@x.com" }))

    await poller.tick()

    expect(await countRows()).toBe(3)

    const cursor = await pool.query<{ last_event_id: string | null; locked_until: Date | null }>(
      "SELECT last_event_id, locked_until FROM workos_event_poller_state WHERE name = $1",
      [lockName]
    )
    expect(cursor.rows[0]).toMatchObject({ last_event_id: eventIds[2], locked_until: null })

    const denied = await pool.query<{ outcome: string }>("SELECT outcome FROM auth_log WHERE workos_event_id = $1", [
      eventIds[0],
    ])
    expect(denied.rows[0].outcome).toBe("denied")

    const impersonated = await pool.query<{ impersonator_email: string | null }>(
      "SELECT impersonator_email FROM auth_log WHERE workos_event_id = $1",
      [eventIds[1]]
    )
    expect(impersonated.rows[0].impersonator_email).toBe("op@workos.com")

    // Second run: cursor already at the tail, but even a full replay is a no-op
    // because the repository dedupes on workos_event_id.
    await poller.tick()
    expect(await countRows()).toBe(3)
  })

  test("replay from a reset cursor still dedupes on event id", async () => {
    const { stub, lock, poller } = makeStack()
    await lock.ensureRow()

    stub.pushEvent(rawEvent(eventIds[0], "session.created", { object: "session", userId: "user_a" }))
    await poller.tick()
    expect(await countRows()).toBe(1)

    // Simulate a cursor rewind (operator re-ingestion). The same page returns;
    // ON CONFLICT DO NOTHING keeps the row count flat.
    await pool.query("UPDATE workos_event_poller_state SET last_event_id = NULL WHERE name = $1", [lockName])
    await poller.tick()
    expect(await countRows()).toBe(1)
  })

  test("an un-ingestible event is skipped with the cursor advanced, not a stall", async () => {
    const { stub, lock, poller } = makeStack()
    await lock.ensureRow()

    // Malformed ipAddress → INET insert throws for this event only.
    stub.pushEvent(
      rawEvent(eventIds[0], "authentication.password_failed", { email: "bad@x.com", ipAddress: "not-an-ip" })
    )
    stub.pushEvent(rawEvent(eventIds[1], "user.created", { object: "user", id: "user_ok", email: "ok@x.com" }))

    await poller.tick()

    // The bad event produced no row, the good one landed, and the cursor moved
    // past both — the auth trail keeps flowing.
    expect(await countRows()).toBe(1)
    const cursor = await pool.query<{ last_event_id: string | null }>(
      "SELECT last_event_id FROM workos_event_poller_state WHERE name = $1",
      [lockName]
    )
    expect(cursor.rows[0].last_event_id).toBe(eventIds[1])
  })
})
