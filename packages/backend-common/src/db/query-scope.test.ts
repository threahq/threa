import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import type { PoolConfig } from "pg"
import { createDatabasePool } from "./index"
import { QueryCounter } from "./query-scope"

type Callback = (err: Error | undefined, result?: unknown) => void

class FakeClient extends EventEmitter {
  connect(cb: Callback): void {
    setImmediate(() => cb(undefined))
  }

  query(_text: string, values?: unknown, cb?: Callback): Promise<unknown> | void {
    const callback = typeof values === "function" ? (values as Callback) : cb
    const result = { rows: [], rowCount: 0 }
    if (callback) {
      setImmediate(() => callback(undefined, result))
      return
    }
    return new Promise((resolve) => setImmediate(() => resolve(result)))
  }

  end(cb?: () => void): void {
    cb?.()
  }
}

function countedPool(max: number) {
  const pool = createDatabasePool("postgres://fake/fake", {
    max,
    Client: FakeClient as unknown as PoolConfig["Client"],
  })
  const queryCounter = new QueryCounter()
  queryCounter.instrument(pool)
  return { pool, queryCounter }
}

describe("query scope", () => {
  test("should count pool queries and checked-out client queries when a scope is active", async () => {
    const { pool, queryCounter } = countedPool(2)

    const counted = await queryCounter.run(async (scope) => {
      await pool.query("SELECT 1")
      const client = await pool.connect()
      await client.query("SELECT 2")
      await client.query("SELECT 3")
      client.release()
      return scope.count
    })

    expect(counted).toBe(3)
    await pool.end()
  })

  test("should count into the waiting caller's scope when another scope hands it the connection", async () => {
    const { pool, queryCounter } = countedPool(1)
    let releaseHolder: () => void = () => {}
    const holderDone = new Promise<void>((resolve) => (releaseHolder = resolve))

    const holder = queryCounter.run(async (scope) => {
      const client = await pool.connect()
      await client.query("SELECT 1")
      await holderDone
      client.release()
      return scope.count
    })
    await new Promise((resolve) => setImmediate(resolve))

    const waiter = queryCounter.run(async (scope) => {
      await pool.query("SELECT 2")
      return scope.count
    })
    releaseHolder()

    expect({ holder: await holder, waiter: await waiter }).toEqual({ holder: 1, waiter: 1 })
    await pool.end()
  })

  test("should not count queries when no scope is active", async () => {
    const { pool, queryCounter } = countedPool(1)
    const outside = pool.query("SELECT 1")

    const counted = await queryCounter.run(async (scope) => {
      await outside
      return scope.count
    })

    expect(counted).toBe(0)
    await pool.end()
  })
})
