import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase } from "./setup"
import {
  CursorLock,
  ensureListener,
  compact,
  hasUnfilledGaps,
  type ProcessResult,
  type CursorLockConfig,
  type ProcessedIdsMap,
} from "@threa/backend-common"
import { OutboxRepository } from "../../src/lib/outbox"

describe("CursorLock", () => {
  let pool: Pool
  const testListenerId = "test_cursor_lock"

  function createTestCursorLock(overrides?: Partial<CursorLockConfig>): CursorLock {
    return new CursorLock({
      pool,
      listenerId: testListenerId,
      lockDurationMs: 10_000,
      refreshIntervalMs: 5_000,
      maxRetries: 3,
      baseBackoffMs: 100,
      batchSize: 10,
      ...overrides,
    })
  }

  async function getListenerState() {
    const result = await pool.query<{
      last_processed_id: string
      processed_ids: ProcessedIdsMap
      retry_count: number
      retry_after: Date | null
      last_error: string | null
      locked_until: Date | null
      lock_run_id: string | null
    }>(
      `SELECT last_processed_id, processed_ids, retry_count, retry_after, last_error, locked_until, lock_run_id
       FROM outbox_listeners WHERE listener_id = $1`,
      [testListenerId]
    )
    return result.rows[0] ?? null
  }

  async function insertTestEvent(eventType: string = "test:event"): Promise<bigint> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO outbox (event_type, payload)
       VALUES ($1, '{"test": true}')
       RETURNING id`,
      [eventType]
    )
    return BigInt(result.rows[0].id)
  }

  async function getLatestOutboxId(): Promise<bigint> {
    const result = await pool.query<{ id: string }>("SELECT COALESCE(MAX(id), 0) AS id FROM outbox")
    return BigInt(result.rows[0].id)
  }

  async function getDeadLetters() {
    const result = await pool.query(
      `SELECT listener_id, outbox_event_id, error
       FROM outbox_dead_letters WHERE listener_id = $1`,
      [testListenerId]
    )
    return result.rows
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query("DELETE FROM outbox_dead_letters WHERE listener_id = $1", [testListenerId])
    await pool.query("DELETE FROM outbox_listeners WHERE listener_id = $1", [testListenerId])
    await pool.query(`DELETE FROM outbox WHERE payload->>'test' = 'true'`)
  })

  describe("ensureListener", () => {
    test("should create listener with default cursor", async () => {
      await ensureListener(pool, testListenerId)

      const state = await getListenerState()
      expect(state).not.toBeNull()
      expect(state!.last_processed_id).toBe("0")
      expect(state!.retry_count).toBe(0)
      expect(state!.retry_after).toBeNull()
    })

    test("should create listener with specified cursor", async () => {
      await ensureListener(pool, testListenerId, 100n)

      const state = await getListenerState()
      expect(state!.last_processed_id).toBe("100")
    })

    test("should not overwrite existing listener", async () => {
      await ensureListener(pool, testListenerId, 50n)
      await ensureListener(pool, testListenerId, 100n)

      const state = await getListenerState()
      expect(state!.last_processed_id).toBe("50")
    })
  })

  describe("run - lock acquisition", () => {
    test("should acquire lock and process events", async () => {
      const eventId = await insertTestEvent()
      await ensureListener(pool, testListenerId, eventId - 1n)

      const cursorLock = createTestCursorLock()
      const calls: { cursor: bigint; processedIds: bigint[] }[] = []

      const didWork = await cursorLock.run(async (cursor, processedIds): Promise<ProcessResult> => {
        calls.push({ cursor, processedIds: [...processedIds] })
        if (calls.length === 1) {
          return { status: "processed", processedIds: [eventId] }
        }
        return { status: "no_events" }
      })

      expect(didWork).toBe(true)
      expect(calls[0].cursor).toBe(eventId - 1n)

      const state = await getListenerState()
      expect(BigInt(state!.last_processed_id)).toBeGreaterThanOrEqual(eventId)
      expect(state!.locked_until).toBeNull()
      expect(state!.lock_run_id).toBeNull()
    })

    test("should return false when listener does not exist", async () => {
      const cursorLock = createTestCursorLock()

      const didWork = await cursorLock.run(async () => {
        throw new Error("Should not be called")
      })

      expect(didWork).toBe(false)
    })

    test("should return false when lock is already held", async () => {
      await ensureListener(pool, testListenerId, 0n)

      const futureTime = new Date(Date.now() + 60_000)
      await pool.query(
        `UPDATE outbox_listeners SET locked_until = $1, lock_run_id = 'other_worker'
         WHERE listener_id = $2`,
        [futureTime, testListenerId]
      )

      const cursorLock = createTestCursorLock()
      const didWork = await cursorLock.run(async () => {
        throw new Error("Should not be called")
      })

      expect(didWork).toBe(false)
    })

    test("should acquire expired lock", async () => {
      const eventId = await insertTestEvent()
      await ensureListener(pool, testListenerId, eventId - 1n)

      const pastTime = new Date(Date.now() - 1000)
      await pool.query(
        `UPDATE outbox_listeners SET locked_until = $1, lock_run_id = 'old_worker'
         WHERE listener_id = $2`,
        [pastTime, testListenerId]
      )

      const cursorLock = createTestCursorLock()
      let callCount = 0
      const didWork = await cursorLock.run(async (): Promise<ProcessResult> => {
        callCount++
        if (callCount === 1) return { status: "processed", processedIds: [eventId] }
        return { status: "no_events" }
      })

      expect(didWork).toBe(true)
    })
  })

  describe("run - backoff check", () => {
    test("should return false when in retry backoff", async () => {
      await ensureListener(pool, testListenerId, 0n)

      const futureTime = new Date(Date.now() + 60_000)
      await pool.query(`UPDATE outbox_listeners SET retry_after = $1 WHERE listener_id = $2`, [
        futureTime,
        testListenerId,
      ])

      const cursorLock = createTestCursorLock()
      const didWork = await cursorLock.run(async () => {
        throw new Error("Should not be called when in backoff")
      })

      expect(didWork).toBe(false)
    })

    test("should process when retry_after has passed", async () => {
      const eventId = await insertTestEvent()
      await ensureListener(pool, testListenerId, eventId - 1n)

      const pastTime = new Date(Date.now() - 1000)
      await pool.query(`UPDATE outbox_listeners SET retry_after = $1 WHERE listener_id = $2`, [
        pastTime,
        testListenerId,
      ])

      const cursorLock = createTestCursorLock()
      let callCount = 0
      const didWork = await cursorLock.run(async (): Promise<ProcessResult> => {
        callCount++
        if (callCount === 1) return { status: "processed", processedIds: [eventId] }
        return { status: "no_events" }
      })

      expect(didWork).toBe(true)
    })

    test("should reset retry state when no_events after recovering from backoff", async () => {
      await ensureListener(pool, testListenerId, 100n)

      const pastTime = new Date(Date.now() - 1000)
      await pool.query(
        `UPDATE outbox_listeners
         SET retry_count = 2, retry_after = $1, last_error = 'Previous error'
         WHERE listener_id = $2`,
        [pastTime, testListenerId]
      )

      const cursorLock = createTestCursorLock()
      const didWork = await cursorLock.run(async (): Promise<ProcessResult> => {
        return { status: "no_events" }
      })

      expect(didWork).toBe(false)

      const state = await getListenerState()
      expect(state!.retry_count).toBe(0)
      expect(state!.retry_after).toBeNull()
      expect(state!.last_error).toBeNull()
      expect(state!.last_processed_id).toBe("100")
    })
  })

  describe("run - exhaust loop", () => {
    test("should repeatedly call processor until no_events", async () => {
      const event1 = await insertTestEvent()
      const event2 = await insertTestEvent()
      const event3 = await insertTestEvent()
      await ensureListener(pool, testListenerId, event1 - 1n)

      // gapWindowMs=0 so cursor advances past all processed IDs immediately,
      // even if concurrent inserts from other test files create gaps
      const cursorLock = createTestCursorLock({ gapWindowMs: 0 })
      const processedEventIds: bigint[] = []

      const didWork = await cursorLock.run(async (cursor, processedIds): Promise<ProcessResult> => {
        const events = await OutboxRepository.fetchAfterId(pool, cursor, 1, processedIds)
        if (events.length === 0) return { status: "no_events" }
        processedEventIds.push(events[0].id)
        return { status: "processed", processedIds: [events[0].id] }
      })

      expect(didWork).toBe(true)
      expect(processedEventIds).toContain(event1)
      expect(processedEventIds).toContain(event2)
      expect(processedEventIds).toContain(event3)

      const state = await getListenerState()
      expect(BigInt(state!.last_processed_id)).toBeGreaterThanOrEqual(event3)
    })

    test("should stop on no_events and report no work when starting exhausted", async () => {
      await ensureListener(pool, testListenerId, 0n)

      const cursorLock = createTestCursorLock()
      const didWork = await cursorLock.run(async (): Promise<ProcessResult> => {
        return { status: "no_events" }
      })

      expect(didWork).toBe(false)
    })

    test("should reject empty processedIds on processed status", async () => {
      await ensureListener(pool, testListenerId, 10n)

      const cursorLock = createTestCursorLock()
      let callCount = 0

      const didWork = await cursorLock.run(async (): Promise<ProcessResult> => {
        callCount++
        return { status: "processed", processedIds: [] }
      })

      expect(didWork).toBe(false)
      expect(callCount).toBe(1)
    })
  })

  describe("run - error handling", () => {
    test("should record error and set retry backoff", async () => {
      const baseId = await getLatestOutboxId()
      await ensureListener(pool, testListenerId, baseId)

      const cursorLock = createTestCursorLock()
      const didWork = await cursorLock.run(async (): Promise<ProcessResult> => {
        return { status: "error", error: new Error("Test error") }
      })

      expect(didWork).toBe(false)

      const state = await getListenerState()
      expect(state!.retry_count).toBe(1)
      expect(state!.retry_after).not.toBeNull()
      expect(state!.last_error).toBe("Test error")
    })

    test("should move event to DLQ after max retries", async () => {
      const eventId = await insertTestEvent()
      await ensureListener(pool, testListenerId, eventId - 1n)

      await pool.query(`UPDATE outbox_listeners SET retry_count = 3 WHERE listener_id = $1`, [testListenerId])

      const cursorLock = createTestCursorLock({ maxRetries: 3 })
      await cursorLock.run(async (): Promise<ProcessResult> => {
        return { status: "error", error: new Error("Fatal error") }
      })

      const deadLetters = await getDeadLetters()
      expect(deadLetters.length).toBe(1)
      expect(deadLetters[0].outbox_event_id).toBe(eventId.toString())
      expect(deadLetters[0].error).toBe("Fatal error")

      const state = await getListenerState()
      expect(state!.last_processed_id).toBe(eventId.toString())
      expect(state!.retry_count).toBe(0)
      expect(state!.retry_after).toBeNull()
    })

    test("should preserve partial progress on error", async () => {
      const event1 = await insertTestEvent()
      const event2 = await insertTestEvent()
      await ensureListener(pool, testListenerId, event1 - 1n)

      const cursorLock = createTestCursorLock()
      await cursorLock.run(async (): Promise<ProcessResult> => {
        return { status: "error", error: new Error("Partial failure"), processedIds: [event1] }
      })

      const state = await getListenerState()
      expect(BigInt(state!.last_processed_id)).toBeGreaterThanOrEqual(event1)
      expect(state!.retry_count).toBe(1)
    })
  })

  describe("run - testable time", () => {
    test("should use provided getNow function for time comparisons", async () => {
      const eventId = await insertTestEvent()
      await ensureListener(pool, testListenerId, eventId - 1n)

      const retryAfter = new Date("2024-01-01T12:00:00Z")
      await pool.query(`UPDATE outbox_listeners SET retry_after = $1 WHERE listener_id = $2`, [
        retryAfter,
        testListenerId,
      ])

      const cursorLock = createTestCursorLock()

      const beforeRetry = () => new Date("2024-01-01T11:59:00Z")
      const didWorkBefore = await cursorLock.run(async () => {
        throw new Error("Should not be called")
      }, beforeRetry)
      expect(didWorkBefore).toBe(false)

      const afterRetry = () => new Date("2024-01-01T12:01:00Z")
      let callCount = 0
      const didWorkAfter = await cursorLock.run(async (): Promise<ProcessResult> => {
        callCount++
        if (callCount === 1) return { status: "processed", processedIds: [eventId] }
        return { status: "no_events" }
      }, afterRetry)
      expect(didWorkAfter).toBe(true)
    })
  })

  describe("lock release on errors", () => {
    test("should release lock even when processor throws", async () => {
      await ensureListener(pool, testListenerId, 0n)

      const cursorLock = createTestCursorLock()

      try {
        await cursorLock.run(async () => {
          throw new Error("Unexpected crash")
        })
      } catch {
        // Expected
      }

      const state = await getListenerState()
      expect(state!.locked_until).toBeNull()
      expect(state!.lock_run_id).toBeNull()
    })
  })

  describe("compact (pure function)", () => {
    test("should merge new IDs into processed set", () => {
      const result = compact(10n, {}, [11n, 12n, 13n], new Date(), 1000)

      // All contiguous with cursor 10: should advance to 13
      expect(result.cursor).toBe(13n)
      expect(Object.keys(result.processedIds)).toHaveLength(0)
    })

    test("should preserve uncompacted entries within window", () => {
      const now = new Date()
      // IDs 12 and 14 are in the window (just added), 13 is a gap
      const result = compact(10n, {}, [12n, 14n], now, 1000)

      // No entries are expired yet (all just added), so base stays at 10
      expect(result.cursor).toBe(10n)
      expect(Object.keys(result.processedIds)).toHaveLength(2)
      expect(result.processedIds["12"]).toBe(now.toISOString())
      expect(result.processedIds["14"]).toBe(now.toISOString())
    })

    test("should compact expired entries and advance cursor past gaps", () => {
      const now = new Date()
      const oldTime = new Date(now.getTime() - 2000).toISOString()

      // IDs 11, 12, 14 were processed 2s ago (expired at 1s window)
      // 13 is a gap that never appeared
      const processedIds: ProcessedIdsMap = {
        "11": oldTime,
        "12": oldTime,
        "14": oldTime,
      }

      const result = compact(10n, processedIds, [], now, 1000)

      // max expired = 14, so base advances to 14
      // All entries <= 14 are removed
      expect(result.cursor).toBe(14n)
      expect(Object.keys(result.processedIds)).toHaveLength(0)
    })

    test("should advance through contiguous entries after compaction", () => {
      const now = new Date()
      const oldTime = new Date(now.getTime() - 2000).toISOString()

      // 11 is expired, 12 and 13 are fresh (just added)
      const processedIds: ProcessedIdsMap = {
        "11": oldTime,
        "12": now.toISOString(),
        "13": now.toISOString(),
      }

      const result = compact(10n, processedIds, [], now, 1000)

      // max expired = 11, base advances to 11
      // Then 12 and 13 are contiguous with 11, so base advances to 13
      expect(result.cursor).toBe(13n)
      expect(Object.keys(result.processedIds)).toHaveLength(0)
    })

    test("should handle DLQ with processed set exclusion", () => {
      const now = new Date()
      // Simulate: cursor at 10, we've processed 12 and 13, but 11 failed repeatedly
      // After DLQ moves 11, the processed set should be {12, 13}
      // Next compact after adding 11 to processed should advance cursor to 13
      const processedIds: ProcessedIdsMap = {
        "12": now.toISOString(),
        "13": now.toISOString(),
      }

      const result = compact(10n, processedIds, [11n], now, 1000)

      // 11, 12, 13 are all contiguous with cursor 10 — advance to 13
      expect(result.cursor).toBe(13n)
      expect(Object.keys(result.processedIds)).toHaveLength(0)
    })

    test("should accumulate processedIds across exhaust loop iterations", () => {
      const now = new Date()

      // Iteration 1: process IDs 12, 15 (gaps at 11, 13, 14)
      const state1 = compact(10n, {}, [12n, 15n], now, 1000)
      expect(state1.cursor).toBe(10n)
      expect(Object.keys(state1.processedIds)).toHaveLength(2)

      // Iteration 2: process IDs 11, 13 (filling some gaps)
      const state2 = compact(state1.cursor, state1.processedIds, [11n, 13n], now, 1000)
      // 11, 12, 13 contiguous with 10 → advance to 13. 15 remains in window
      expect(state2.cursor).toBe(13n)
      expect(Object.keys(state2.processedIds)).toHaveLength(1)
      expect(state2.processedIds["15"]).toBeDefined()

      // Iteration 3: process ID 14 (fills the last gap)
      const state3 = compact(state2.cursor, state2.processedIds, [14n], now, 1000)
      // 14, 15 contiguous with 13 → advance to 15
      expect(state3.cursor).toBe(15n)
      expect(Object.keys(state3.processedIds)).toHaveLength(0)
    })
  })

  describe("sliding window - integration", () => {
    test("should pick up events that appear in gaps after compaction", async () => {
      const baseId = await getLatestOutboxId()
      const event1 = await insertTestEvent()
      const event2 = await insertTestEvent()
      await ensureListener(pool, testListenerId, baseId)

      // gapWindowMs=0 with <= comparison means entries expire immediately;
      // gapCeilingMs=0 bypasses the transaction-liveness hold so this test
      // exercises the window machinery deterministically
      const cursorLock = createTestCursorLock({ gapWindowMs: 0, gapCeilingMs: 0 })

      const didWork = await cursorLock.run(async (cursor, processedIds): Promise<ProcessResult> => {
        const events = await OutboxRepository.fetchAfterId(pool, cursor, 10, processedIds)
        if (events.length === 0) return { status: "no_events" }
        return { status: "processed", processedIds: events.map((e) => e.id) }
      })

      expect(didWork).toBe(true)

      const state = await getListenerState()
      expect(BigInt(state!.last_processed_id)).toBeGreaterThanOrEqual(event2)
    })

    test("should pass processedIds to processor across exhaust loop iterations", async () => {
      const event1 = await insertTestEvent()
      const event2 = await insertTestEvent()
      // Cursor far before events creates non-contiguous gap, so processedIds
      // won't be consumed by contiguous advancement
      await ensureListener(pool, testListenerId, event1 - 2n)

      // Long gap window keeps entries in the processed set between iterations
      const cursorLock = createTestCursorLock({ gapWindowMs: 60_000 })
      const processedIdsSeen: bigint[][] = []
      let callCount = 0

      const didWork = await cursorLock.run(async (cursor, processedIds): Promise<ProcessResult> => {
        processedIdsSeen.push([...processedIds])
        callCount++
        if (callCount === 1) return { status: "processed", processedIds: [event1] }
        if (callCount === 2) return { status: "processed", processedIds: [event2] }
        return { status: "no_events" }
      })

      expect(didWork).toBe(true)
      // First call: no processedIds yet
      expect(processedIdsSeen[0]).toHaveLength(0)
      // Second call: event1 should be in processedIds (non-contiguous, stays in window)
      expect(processedIdsSeen[1]).toContainEqual(event1)
    })
  })

  describe("compact - gap liveness guard (pure function)", () => {
    test("hasUnfilledGaps detects holes between cursor and tracked ids", () => {
      expect(hasUnfilledGaps(10n, {}, [11n, 12n, 13n])).toBe(false)
      expect(hasUnfilledGaps(10n, {}, [12n])).toBe(true)
      expect(hasUnfilledGaps(10n, { "11": new Date().toISOString() }, [13n])).toBe(true)
      expect(hasUnfilledGaps(10n, { "11": new Date().toISOString() }, [12n])).toBe(false)
      expect(hasUnfilledGaps(10n, {}, [])).toBe(false)
    })

    test("holds an expired entry above a gap while a transaction predating it runs", () => {
      const now = new Date()
      const readAt = new Date(now.getTime() - 5000)
      // Entry 14 (gap at 11-13) expired by the window, but a transaction that
      // started before it was observed is still running — could still fill 11.
      const result = compact(10n, { "14": readAt.toISOString() }, [], now, 1000, {
        oldestRunningTxnStart: new Date(readAt.getTime() - 1000),
        gapCeilingMs: 60_000,
      })

      expect(result.cursor).toBe(10n)
      expect(result.processedIds["14"]).toBeDefined()
    })

    test("skips the gap once every running transaction postdates the observation", () => {
      const now = new Date()
      const readAt = new Date(now.getTime() - 5000)
      const result = compact(10n, { "14": readAt.toISOString() }, [], now, 1000, {
        // Oldest running transaction started well after entry 14 was observed
        // (past the clock-skew pad) — the gap's owner has provably ended.
        oldestRunningTxnStart: new Date(readAt.getTime() + 2000),
        gapCeilingMs: 60_000,
      })

      expect(result.cursor).toBe(14n)
      expect(Object.keys(result.processedIds)).toHaveLength(0)
    })

    test("skips the gap when no transaction is running at all", () => {
      const now = new Date()
      const readAt = new Date(now.getTime() - 5000)
      const result = compact(10n, { "14": readAt.toISOString() }, [], now, 1000, {
        oldestRunningTxnStart: null,
        gapCeilingMs: 60_000,
      })

      expect(result.cursor).toBe(14n)
    })

    test("the ceiling forces the skip past an abandoned long transaction", () => {
      const now = new Date()
      const readAt = new Date(now.getTime() - 5000)
      const result = compact(10n, { "14": readAt.toISOString() }, [], now, 1000, {
        oldestRunningTxnStart: new Date(now.getTime() - 600_000),
        gapCeilingMs: 3000,
      })

      expect(result.cursor).toBe(14n)
    })
  })

  describe("run - transaction liveness gap guard", () => {
    test("holds a gap open while the owning transaction runs, then processes the late commit", async () => {
      // Transaction A allocates an outbox id but stays uncommitted — the
      // classic BIGSERIAL visibility gap, held open longer than the window.
      const txnClient = await pool.connect()
      try {
        await txnClient.query("BEGIN")
        const inFlight = await txnClient.query<{ id: string }>(
          `INSERT INTO outbox (event_type, payload) VALUES ('test:event', '{"test": true}') RETURNING id`
        )
        const gapId = BigInt(inFlight.rows[0].id)
        const visibleId = await insertTestEvent()
        expect(visibleId).toBeGreaterThan(gapId)

        await ensureListener(pool, testListenerId, gapId - 1n)
        const cursorLock = createTestCursorLock({ gapWindowMs: 10 })

        const processed: bigint[] = []
        const processor = async (cursor: bigint, processedIds: bigint[]): Promise<ProcessResult> => {
          const events = await OutboxRepository.fetchAfterId(pool, cursor, 10, processedIds)
          if (events.length === 0) return { status: "no_events" }
          processed.push(...events.map((e) => e.id))
          return { status: "processed", processedIds: events.map((e) => e.id) }
        }

        await cursorLock.run(processor)
        // Window expired while transaction A still runs. Commit ANOTHER event
        // so the next run processes a real batch — compaction only happens on
        // the processed path, so without this the second run would return
        // no_events and never reach the gap guard at all (the pre-hardening
        // window would pass a no-op run too).
        await new Promise((r) => setTimeout(r, 50))
        const laterId = await insertTestEvent()
        await cursorLock.run(processor)

        // The guard must hold the cursor below the gap even though the gap
        // window expired — the pre-hardening compaction would have expired
        // visibleId and pulled the cursor past gapId here.
        expect(processed).toContain(laterId)
        let state = await getListenerState()
        expect(BigInt(state!.last_processed_id)).toBeLessThan(gapId)

        // Transaction A commits after the gap window — the pre-hardening
        // window would have skipped this event permanently.
        await txnClient.query("COMMIT")
        await cursorLock.run(processor)

        expect(processed).toContain(gapId)
        state = await getListenerState()
        expect(BigInt(state!.last_processed_id)).toBeGreaterThanOrEqual(laterId)
      } finally {
        txnClient.release()
      }
    })
  })
})
