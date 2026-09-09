import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { WaitlistService } from "../../src/features/waitlist"
import type { WaitlistEmailSender, WaitlistNotifier, WaitlistSignup } from "../../src/features/waitlist"
import { setupTestDatabase } from "./setup"

/**
 * WaitlistService against the real control_plane schema. Verifies the contract
 * that HTTP tests can't see: a confirmation is sent and the signup announced
 * only on a genuinely new row (not on duplicate re-submits), the email is
 * normalized before storage, and neither side effect failing fails the signup.
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

  function recordingNotifier() {
    const posted: WaitlistSignup[] = []
    const notifier: WaitlistNotifier = {
      async notifySignup(signup) {
        posted.push(signup)
      },
    }
    return { notifier, posted }
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

  test("stores a normalized email, sends one confirmation and announces the signup", async () => {
    const { sender, sent } = recordingSender()
    const { notifier, posted } = recordingNotifier()
    const service = new WaitlistService({ pool, emailSender: sender, notifier })

    await service.signUp({ email: "  New.Person@Example.com ", source: "home" })

    const rows = await pool.query<{ id: string; email: string; source: string | null; status: string }>(
      "SELECT id, email, source, status FROM waitlist"
    )
    const stored = rows.rows[0]
    expect(rows.rows).toEqual([
      { id: expect.stringMatching(/^wl_/), email: "new.person@example.com", source: "home", status: "pending" },
    ])
    expect(sent).toEqual(["new.person@example.com"])
    // The announcement carries the stored row id, which is what the notifier
    // keys its idempotency on.
    expect(posted).toEqual([{ id: stored.id, email: "new.person@example.com", source: "home" }])
  })

  test("dedupes case/whitespace variants and neither re-sends nor re-announces", async () => {
    const { sender, sent } = recordingSender()
    const { notifier, posted } = recordingNotifier()
    const service = new WaitlistService({ pool, emailSender: sender, notifier })

    await service.signUp({ email: "dup@example.com", source: "home" })
    await service.signUp({ email: "  DUP@example.com ", source: "about" })

    const count = await pool.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM waitlist")
    expect(count.rows[0].n).toBe("1")
    expect(sent).toEqual(["dup@example.com"])
    expect(posted.map((p) => p.email)).toEqual(["dup@example.com"])
  })

  test("a confirmation send failure does not fail the signup and still announces it", async () => {
    const sender: WaitlistEmailSender = {
      async sendConfirmation() {
        throw new Error("provider down")
      },
    }
    const { notifier, posted } = recordingNotifier()
    const service = new WaitlistService({ pool, emailSender: sender, notifier })

    let threw = false
    try {
      await service.signUp({ email: "kept@example.com", source: null })
    } catch {
      threw = true
    }
    expect(threw).toBe(false)

    const count = await pool.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM waitlist")
    expect(count.rows[0].n).toBe("1")
    expect(posted.map((p) => p.email)).toEqual(["kept@example.com"])
  })

  test("a notification failure does not fail the signup", async () => {
    const { sender, sent } = recordingSender()
    const notifier: WaitlistNotifier = {
      async notifySignup() {
        throw new Error("threa api down")
      },
    }
    const service = new WaitlistService({ pool, emailSender: sender, notifier })

    let threw = false
    try {
      await service.signUp({ email: "announced@example.com", source: "home" })
    } catch {
      threw = true
    }
    expect(threw).toBe(false)

    const count = await pool.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM waitlist")
    expect(count.rows[0].n).toBe("1")
    expect(sent).toEqual(["announced@example.com"])
  })
})
