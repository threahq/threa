import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test"
import { Pool } from "pg"
import { logger } from "@threahq/backend-common"
import { executeReadOnly } from "../src/query"

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://threa:threa@localhost:5454/postgres"

describe("executeReadOnly success logging", () => {
  const pool = new Pool({ connectionString: TEST_DATABASE_URL })

  afterAll(async () => {
    await pool.end()
  })

  afterEach(() => {
    spyOn(logger, "info").mockRestore()
  })

  test("logs the executed SQL, rowCount, truncated, and duration on success", async () => {
    const infoSpy = spyOn(logger, "info")

    const result = await executeReadOnly({ sql: "SELECT 1 AS n" }, { pool, statementTimeoutMs: 5_000, maxRows: 100 })

    expect(result.rowCount).toBe(1)

    const okCall = infoSpy.mock.calls.find(([, msg]) => msg === "db-read-proxy query ok")
    expect(okCall).toBeDefined()
    const [fields] = okCall as [Record<string, unknown>, string]
    expect(fields.sql).toBe("SELECT 1 AS n")
    expect(fields.rowCount).toBe(1)
    expect(fields.truncated).toBe(false)
    expect(typeof fields.durationMs).toBe("number")
  })
})
