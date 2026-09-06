import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { authLogId } from "@threahq/backend-common"
import { AuthLogRetentionWorker } from "../../src/features/auth-log"
import { setupTestDatabase } from "./setup"

describe("AuthLogRetentionWorker", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  test("cleanup deletes rows past the retention horizon and spares fresh ones", async () => {
    const oldId = authLogId()
    const freshId = authLogId()
    await pool.query(
      `INSERT INTO auth_log (id, occurred_at, event_type, outcome)
       VALUES ($1, now() - interval '400 days', 'user.created', 'success'),
              ($2, now(), 'user.created', 'success')`,
      [oldId, freshId]
    )

    const worker = new AuthLogRetentionWorker(pool, { retentionMs: 396 * 24 * 60 * 60 * 1000 })
    await worker.cleanup()

    const { rows } = await pool.query<{ id: string }>("SELECT id FROM auth_log WHERE id = ANY($1)", [[oldId, freshId]])
    expect(rows.map((r) => r.id)).toEqual([freshId])
  })
})
