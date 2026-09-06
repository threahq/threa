import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { OutboxRepository } from "@threahq/backend-common"
import { setupTestDatabase } from "./setup"

const LISTENER = "test-listener"

async function ensureListener(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO outbox_listeners (listener_id, last_processed_id, processed_ids)
     VALUES ($1, 0, '{}'::jsonb)
     ON CONFLICT (listener_id) DO NOTHING`,
    [LISTENER]
  )
}

async function setListenerState(
  pool: Pool,
  lastProcessedId: bigint,
  processedIds: Record<string, string>
): Promise<void> {
  await pool.query(
    `UPDATE outbox_listeners
       SET last_processed_id = $2,
           processed_ids = $3::jsonb,
           updated_at = NOW()
       WHERE listener_id = $1`,
    [LISTENER, lastProcessedId.toString(), JSON.stringify(processedIds)]
  )
}

async function deadLetter(pool: Pool, eventId: bigint, error = "boom"): Promise<void> {
  await pool.query(
    `INSERT INTO outbox_dead_letters (listener_id, outbox_event_id, error) VALUES ($1, $2::bigint, $3)`,
    [LISTENER, eventId.toString(), error]
  )
}

async function insertEvent(pool: Pool): Promise<bigint> {
  const row = await pool.query<{ id: string }>(
    `INSERT INTO outbox (event_type, payload) VALUES ('test_event', '{}'::jsonb) RETURNING id::text AS id`
  )
  return BigInt(row.rows[0]!.id)
}

describe("OutboxRepository.getEventStatuses", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query(`DELETE FROM outbox_dead_letters WHERE listener_id = $1`, [LISTENER])
    await pool.query(`DELETE FROM outbox_listeners WHERE listener_id = $1`, [LISTENER])
  })

  test("empty input returns empty result without hitting the DB", async () => {
    const result = await OutboxRepository.getEventStatuses(pool, LISTENER, [])
    expect(result).toEqual([])
  })

  test("events at or below the cursor are processed", async () => {
    const id1 = await insertEvent(pool)
    const id2 = await insertEvent(pool)
    await ensureListener(pool)
    await setListenerState(pool, id2, {})

    const result = await OutboxRepository.getEventStatuses(pool, LISTENER, [id1, id2])
    expect(result).toEqual([
      { id: id1.toString(), status: "processed" },
      { id: id2.toString(), status: "processed" },
    ])
  })

  test("events in the sliding window are processed even when above the cursor", async () => {
    const id1 = await insertEvent(pool)
    const id2 = await insertEvent(pool)
    await ensureListener(pool)
    // Cursor stalled at id1 due to a gap, but id2 was processed and parked
    // in the sliding window. Status should reflect that.
    await setListenerState(pool, id1, { [id2.toString()]: new Date().toISOString() })

    const result = await OutboxRepository.getEventStatuses(pool, LISTENER, [id2])
    expect(result).toEqual([{ id: id2.toString(), status: "processed" }])
  })

  test("events above the cursor and outside the window are pending", async () => {
    const id1 = await insertEvent(pool)
    const id2 = await insertEvent(pool)
    await ensureListener(pool)
    await setListenerState(pool, id1, {})

    const result = await OutboxRepository.getEventStatuses(pool, LISTENER, [id2])
    expect(result).toEqual([{ id: id2.toString(), status: "pending" }])
  })

  test("dead-lettered events surface as dead_lettered even if the cursor moved past", async () => {
    // Mirrors CursorLock.moveFirstEventToDLQ: it advances the cursor past
    // the poison event while also writing to outbox_dead_letters. Without
    // the DLQ check, getEventStatuses would falsely report the event as
    // processed.
    const id1 = await insertEvent(pool)
    await ensureListener(pool)
    await setListenerState(pool, id1, {})
    await deadLetter(pool, id1, "max retries exceeded")

    const result = await OutboxRepository.getEventStatuses(pool, LISTENER, [id1])
    expect(result).toEqual([{ id: id1.toString(), status: "dead_lettered" }])
  })

  test("missing listener row reports everything as pending (DLQ entries still surface)", async () => {
    const id1 = await insertEvent(pool)
    const id2 = await insertEvent(pool)
    await deadLetter(pool, id2)

    const result = await OutboxRepository.getEventStatuses(pool, LISTENER, [id1, id2])
    expect(result).toEqual([
      { id: id1.toString(), status: "pending" },
      { id: id2.toString(), status: "dead_lettered" },
    ])
  })

  test("preserves input order across mixed statuses", async () => {
    const id1 = await insertEvent(pool)
    const id2 = await insertEvent(pool)
    const id3 = await insertEvent(pool)
    await ensureListener(pool)
    await setListenerState(pool, id1, {})
    await deadLetter(pool, id3)

    const result = await OutboxRepository.getEventStatuses(pool, LISTENER, [id3, id1, id2])
    expect(result.map((r) => r.id)).toEqual([id3.toString(), id1.toString(), id2.toString()])
    expect(result.map((r) => r.status)).toEqual(["dead_lettered", "processed", "pending"])
  })
})
