import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { WaitlistService } from "../../src/features/waitlist"
import type { WaitlistEmailSender } from "../../src/features/waitlist"
import { setupTestDatabase } from "./setup"

/**
 * WaitlistService against the real control_plane schema. Verifies the contract
 * that HTTP tests can't see: a confirmation is sent only on a genuinely new
 * row (not on duplicate re-submits), the email is normalized before storage,
 * and a send failure never fails the signup.
 */
describe("WaitlistService", () => {
  let pool: Pool

  function recordingSender() {
    const sent: string[] = []
    const sender: WaitlistEmailSender = {
      async sendConfirmation(email) {
        sent.push(email)
      },
    }
    return { sender, sent }
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query("TRUNCATE waitlist")
  })

  test("stores a normalized email and sends one confirmation on a new signup", async () => {
    const { sender, sent } = recordingSender()
    const service = new WaitlistService({ pool, emailSender: sender })

    await service.signUp({ email: "  New.Person@Example.com ", source: "home" })

    const rows = await pool.query<{ email: string; source: string | null; status: string }>(
      "SELECT email, source, status FROM waitlist"
    )
    expect(rows.rows).toEqual([{ email: "new.person@example.com", source: "home", status: "pending" }])
    expect(sent).toEqual(["new.person@example.com"])
  })

  test("dedupes case/whitespace variants and does not re-send", async () => {
    const { sender, sent } = recordingSender()
    const service = new WaitlistService({ pool, emailSender: sender })

    await service.signUp({ email: "dup@example.com", source: "home" })
    await service.signUp({ email: "  DUP@example.com ", source: "about" })

    const count = await pool.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM waitlist")
    expect(count.rows[0].n).toBe("1")
    expect(sent).toEqual(["dup@example.com"])
  })

  test("a confirmation send failure does not fail the signup", async () => {
    const sender: WaitlistEmailSender = {
      async sendConfirmation() {
        throw new Error("provider down")
      },
    }
    const service = new WaitlistService({ pool, emailSender: sender })

    let threw = false
    try {
      await service.signUp({ email: "kept@example.com", source: null })
    } catch {
      threw = true
    }
    expect(threw).toBe(false)

    const count = await pool.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM waitlist")
    expect(count.rows[0].n).toBe("1")
  })
})
