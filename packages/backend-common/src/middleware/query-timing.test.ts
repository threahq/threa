import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import type { AddressInfo } from "node:net"
import express from "express"
import type { PoolConfig } from "pg"
import { createDatabasePool } from "../db/index"
import { QueryCounter } from "../db/query-scope"
import { createQueryTimingMiddleware, QUERY_COUNT_REQUEST_HEADER } from "./query-timing"

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
  test("should report the query count only when the request asks for it", async () => {
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
      const url = `http://127.0.0.1:${port}/`
      const asked = await fetch(url, { headers: { [QUERY_COUNT_REQUEST_HEADER]: "1" } })
      const plain = await fetch(url)
      expect({
        asked: asked.headers.get("server-timing"),
        plain: plain.headers.get("server-timing"),
      }).toEqual({ asked: 'db;desc="2 queries"', plain: null })
    } finally {
      server.close()
      await pool.end()
    }
  })
})
