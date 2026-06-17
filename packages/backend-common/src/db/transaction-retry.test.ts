import { describe, expect, test } from "bun:test"
import type { Pool, PoolClient } from "pg"
import { withTransaction } from "./index"

class FakeClient {
  queries: string[] = []
  released = false
  releasedDestroyed = false

  async query(text: string): Promise<unknown> {
    this.queries.push(text)
    return { rows: [], rowCount: 0 }
  }

  release(destroy?: boolean): void {
    this.released = true
    if (destroy) this.releasedDestroyed = true
  }
}

class FakePool {
  clients: FakeClient[] = []

  async connect(): Promise<PoolClient> {
    const client = new FakeClient()
    this.clients.push(client)
    return client as unknown as PoolClient
  }
}

function pgError(code: string): Error & { code: string } {
  const err = new Error(`pg error ${code}`) as Error & { code: string }
  err.code = code
  return err
}

describe("withTransaction retry", () => {
  test("retries the whole transaction on a deadlock and succeeds", async () => {
    const pool = new FakePool()
    let calls = 0

    const result = await withTransaction(pool as unknown as Pool, async () => {
      calls++
      if (calls === 1) throw pgError("40P01") // deadlock_detected on first attempt
      return "ok"
    })

    expect(result).toBe("ok")
    expect(calls).toBe(2)
    // Two attempts => two connections; the first is rolled back and returned to
    // the pool intact (not destroyed), since a deadlocked connection stays healthy.
    expect(pool.clients).toHaveLength(2)
    expect(pool.clients[0].queries).toEqual(["BEGIN", "ROLLBACK"])
    expect(pool.clients[0].releasedDestroyed).toBe(false)
    expect(pool.clients[1].queries).toEqual(["BEGIN", "COMMIT"])
  })

  test("gives up after exhausting attempts and rethrows the deadlock", async () => {
    const pool = new FakePool()
    let calls = 0

    await expect(
      withTransaction(pool as unknown as Pool, async () => {
        calls++
        throw pgError("40P01")
      })
    ).rejects.toMatchObject({ code: "40P01" })

    expect(calls).toBe(3)
  })

  test("does not retry on a non-retryable error", async () => {
    const pool = new FakePool()
    let calls = 0

    await expect(
      withTransaction(pool as unknown as Pool, async () => {
        calls++
        throw pgError("23505") // unique_violation - a real failure, not transient
      })
    ).rejects.toMatchObject({ code: "23505" })

    expect(calls).toBe(1)
  })
})
