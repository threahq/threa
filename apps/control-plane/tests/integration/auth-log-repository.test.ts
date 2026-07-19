import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { AuthLogRepository } from "../../src/features/auth-log"
import type { AuthLogRowInput } from "../../src/features/auth-log"
import { setupTestDatabase } from "./setup"

describe("AuthLogRepository", () => {
  let pool: Pool
  const eventId = "event_repo_idempotency"

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query("DELETE FROM auth_log WHERE workos_event_id = $1 OR workos_event_id IS NULL", [eventId])
  })

  function row(overrides: Partial<AuthLogRowInput> = {}): AuthLogRowInput {
    return {
      occurredAt: new Date("2026-07-18T10:00:00.000Z"),
      workosEventId: eventId,
      eventType: "session.created",
      workosUserId: "user_x",
      email: "x@example.com",
      organizationId: "org_x",
      impersonatorEmail: null,
      ip: "203.0.113.1",
      userAgent: "agent",
      outcome: "success",
      detail: { authMethod: "password" },
      ...overrides,
    }
  }

  test("same workos_event_id inserted twice yields one row (ON CONFLICT DO NOTHING)", async () => {
    const first = await AuthLogRepository.insert(pool, row())
    const second = await AuthLogRepository.insert(pool, row({ email: "changed@example.com" }))

    expect(first).toBe(true)
    expect(second).toBe(false)

    const count = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM auth_log WHERE workos_event_id = $1",
      [eventId]
    )
    expect(Number(count.rows[0].count)).toBe(1)

    const stored = await pool.query<{ email: string; ip: string; detail: unknown }>(
      "SELECT email, host(ip) AS ip, detail FROM auth_log WHERE workos_event_id = $1",
      [eventId]
    )
    expect(stored.rows[0].email).toBe("x@example.com")
    expect(stored.rows[0].ip).toBe("203.0.113.1")
    expect(stored.rows[0].detail).toEqual({ authMethod: "password" })
  })

  test("own-handler rows (NULL event id) always insert and never dedupe", async () => {
    const a = await AuthLogRepository.insert(pool, row({ workosEventId: null, eventType: "cp.callback_failed" }))
    const b = await AuthLogRepository.insert(pool, row({ workosEventId: null, eventType: "cp.callback_failed" }))
    expect(a).toBe(true)
    expect(b).toBe(true)

    const count = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM auth_log WHERE workos_event_id IS NULL AND event_type = 'cp.callback_failed'"
    )
    expect(Number(count.rows[0].count)).toBe(2)
  })
})
