import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import type { AddressInfo } from "node:net"
import express from "express"
import type { PoolConfig } from "pg"
import { createDatabasePool } from "../db/index"
import { QueryCounter } from "../db/query-scope"
import { createQueryTimingMiddleware } from "./query-timing"

class FakeClient extends EventEmitter {
  connect(cb: (err: Error | undefined) => void): void {
    setImmediate(() => cb(undefined))
  }

  query(_text: string, _values: unknown, cb: (err: Error | undefined, result: unknown) => void): void {
    setImmediate(() => cb(undefined, { rows: [], rowCount: 0 }))
  }

  end(cb?: () => void): void {
    cb?.()
  }
}

describe("createQueryTimingMiddleware", () => {
  test("should report the request's query count", async () => {
    const pool = createDatabasePool("postgres://fake/fake", { Client: FakeClient as unknown as PoolConfig["Client"] })
    const queryCounter = new QueryCounter()
    queryCounter.instrument(pool)
    const app = express()
    app.use(createQueryTimingMiddleware(queryCounter))
    app.get("/", async (_req, res) => {
      await pool.query("SELECT 1")
      await pool.query("SELECT 2")
      res.json({ ok: true })
    })
    const server = app.listen(0)
    try {
      await new Promise((resolve) => server.once("listening", resolve))
      const { port } = server.address() as AddressInfo
      const response = await fetch(`http://127.0.0.1:${port}/`)
      expect(response.headers.get("server-timing")).toBe('db;desc="2 queries"')
    } finally {
      server.close()
      await pool.end()
    }
  })
})
