import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { GITHUB_WEBHOOK_RETENTION_DAYS, GithubWebhookRetentionSweeper } from "../../src/features/github-webhooks"
import { setupTestDatabase } from "./setup"

const DAY_MS = 24 * 60 * 60 * 1000

async function insertDelivery(pool: Pool, guid: string, ageDays: number): Promise<void> {
  const createdAt = new Date(Date.now() - ageDays * DAY_MS)
  await pool.query(
    `INSERT INTO github_webhook_deliveries
       (id, delivery_guid, event_type, action, installation_id, repository_full_name, payload, matched_regions, status, created_at)
     VALUES ($1, $2, 'pull_request', 'synchronize', '1', 'acme/widgets', '{}'::jsonb, '{}', 'no_routes', $3)`,
    [`ghwd_${guid}`, guid, createdAt]
  )
}

async function guids(pool: Pool): Promise<string[]> {
  const result = await pool.query<{ delivery_guid: string }>(
    "SELECT delivery_guid FROM github_webhook_deliveries ORDER BY delivery_guid"
  )
  return result.rows.map((r) => r.delivery_guid)
}

describe("GithubWebhookRetentionSweeper.sweep", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query("TRUNCATE github_webhook_deliveries")
  })

  test("deletes rows past the retention window and keeps recent rows", async () => {
    await insertDelivery(pool, "old-40d", GITHUB_WEBHOOK_RETENTION_DAYS + 10)
    await insertDelivery(pool, "old-31d", GITHUB_WEBHOOK_RETENTION_DAYS + 1)
    await insertDelivery(pool, "fresh-1d", 1)
    await insertDelivery(pool, "fresh-29d", GITHUB_WEBHOOK_RETENTION_DAYS - 1)

    const sweeper = new GithubWebhookRetentionSweeper({ pool })
    const deleted = await sweeper.sweep()

    expect(deleted).toBe(2)
    expect(await guids(pool)).toEqual(["fresh-1d", "fresh-29d"])
  })

  test("respects the cutoff boundary — a row just inside the window survives, just outside is swept", async () => {
    // retentionDays=10 keeps the arithmetic clear; both rows straddle the cutoff
    // by a few hours so millisecond drift in Date.now() can't flip the result.
    await insertDelivery(pool, "inside", 10 - 0.25)
    await insertDelivery(pool, "outside", 10 + 0.25)

    const sweeper = new GithubWebhookRetentionSweeper({ pool, retentionDays: 10 })
    const deleted = await sweeper.sweep()

    expect(deleted).toBe(1)
    expect(await guids(pool)).toEqual(["inside"])
  })

  test("drains a backlog larger than the batch size across multiple deletes", async () => {
    const expired = 23
    for (let i = 0; i < expired; i++) {
      await insertDelivery(pool, `expired-${String(i).padStart(3, "0")}`, 40)
    }
    await insertDelivery(pool, "keep", 1)

    // batchSize < backlog forces the loop to iterate; a single-batch delete would
    // leave (expired - batchSize) rows behind.
    const sweeper = new GithubWebhookRetentionSweeper({ pool, retentionDays: 30, batchSize: 5 })
    const deleted = await sweeper.sweep()

    expect(deleted).toBe(expired)
    expect(await guids(pool)).toEqual(["keep"])
  })

  test("is a clean no-op when nothing is expired", async () => {
    await insertDelivery(pool, "fresh-a", 2)
    await insertDelivery(pool, "fresh-b", 5)

    const sweeper = new GithubWebhookRetentionSweeper({ pool })
    const deleted = await sweeper.sweep()

    expect(deleted).toBe(0)
    expect(await guids(pool)).toEqual(["fresh-a", "fresh-b"])
  })
})
