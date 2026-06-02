import { describe, test, expect } from "bun:test"
import { TestClient } from "../client"

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
