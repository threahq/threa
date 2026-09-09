import { describe, test, expect } from "bun:test"
import { TestClient } from "../client"
import { createTestPool } from "../integration/setup"

describe("Waitlist", () => {
  test("POST /api/waitlist accepts a valid email", async () => {
    const client = new TestClient()
    const res = await client.post<{ ok: boolean }>("/api/waitlist", {
      email: "waitlist-test@example.com",
      source: "home",
    })
    expect(res.status).toBe(200)
    expect(res.data.ok).toBe(true)
  })

  test("POST /api/waitlist is idempotent for a repeat email", async () => {
    const client = new TestClient()
    const email = "waitlist-dupe@example.com"
    const first = await client.post<{ ok: boolean }>("/api/waitlist", { email })
    const second = await client.post<{ ok: boolean }>("/api/waitlist", { email })
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(second.data.ok).toBe(true)
  })

  test("POST /api/waitlist normalizes case and whitespace to the same row", async () => {
    const client = new TestClient()
    await client.post("/api/waitlist", { email: "Mixed.Case@Example.com" })
    const res = await client.post<{ ok: boolean }>("/api/waitlist", { email: "  mixed.case@example.com  " })
    expect(res.status).toBe(200)
    expect(res.data.ok).toBe(true)
  })

  test("POST /api/waitlist accepts a valid email even when source is empty", async () => {
    const client = new TestClient()
    const res = await client.post<{ ok: boolean }>("/api/waitlist", {
      email: "empty-source@example.com",
      source: "",
    })
    expect(res.status).toBe(200)
    expect(res.data.ok).toBe(true)
  })

  test("POST /api/waitlist accepts a valid email even when source is oversized or non-string", async () => {
    const client = new TestClient()
    const oversized = await client.post<{ ok: boolean }>("/api/waitlist", {
      email: "oversized-source@example.com",
      source: "x".repeat(200),
    })
    expect(oversized.status).toBe(200)
    expect(oversized.data.ok).toBe(true)

    const nonString = await client.post<{ ok: boolean }>("/api/waitlist", {
      email: "nonstring-source@example.com",
      source: { nested: "object" },
    })
    expect(nonString.status).toBe(200)
    expect(nonString.data.ok).toBe(true)
  })

  test("POST /api/waitlist drops a source carrying markdown that would escape a code span", async () => {
    const client = new TestClient()
    const email = "backtick-source@example.com"
    const res = await client.post<{ ok: boolean }>("/api/waitlist", { email, source: "home` @here `x" })
    expect(res.status).toBe(200)
    expect(res.data.ok).toBe(true)

    // The announcement renders `source` inside a code span, so a backtick in it
    // would close the span and turn the rest into a mention (INV-64). The row
    // keeps the signup and drops the source.
    const pool = createTestPool()
    try {
      const rows = await pool.query<{ source: string | null }>("SELECT source FROM waitlist WHERE email = $1", [email])
      expect(rows.rows).toEqual([{ source: null }])
    } finally {
      await pool.end()
    }
  })

  test("POST /api/waitlist rejects an invalid email", async () => {
    const client = new TestClient()
    const res = await client.post<{ error: string; code: string }>("/api/waitlist", { email: "not-an-email" })
    expect(res.status).toBe(400)
    expect(res.data.code).toBe("INVALID_EMAIL")
  })

  test("POST /api/waitlist silently accepts a honeypot hit", async () => {
    const client = new TestClient()
    const res = await client.post<{ ok: boolean }>("/api/waitlist", {
      email: "bot@example.com",
      hp: "i am a bot",
    })
    expect(res.status).toBe(200)
    expect(res.data.ok).toBe(true)
  })
})
