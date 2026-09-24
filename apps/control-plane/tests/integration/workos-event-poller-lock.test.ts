import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { WorkosEventPollerLock } from "../../src/lib/workos-event-poller-lock"
import { setupTestDatabase } from "./setup"

describe("WorkosEventPollerLock", () => {
  let pool: Pool
  const lockName = "test-workos-events"

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query("DELETE FROM workos_event_poller_state WHERE name = $1", [lockName])
  })

  function makeLock(overrides?: Partial<ConstructorParameters<typeof WorkosEventPollerLock>[0]>) {
    return new WorkosEventPollerLock({
      pool,
      name: lockName,
      lockDurationMs: 1_000,
      refreshIntervalMs: 500,
      maxRetries: 3,
      baseBackoffMs: 100,
      ...overrides,
    })
  }

  async function getState() {
    const result = await pool.query<{
      last_event_id: string | null
      last_event_at: Date | null
      last_backfill_at: Date | null
      locked_until: Date | null
      lock_run_id: string | null
      retry_count: number
      retry_after: Date | null
      last_error: string | null
    }>(
      `SELECT last_event_id, last_event_at, last_backfill_at, locked_until, lock_run_id,
              retry_count, retry_after, last_error
       FROM workos_event_poller_state WHERE name = $1`,
      [lockName]
    )
    return result.rows[0] ?? null
  }

  test("ensureRow is idempotent", async () => {
    const lock = makeLock()
    await lock.ensureRow()
    await lock.ensureRow()
    const state = await getState()
    expect(state).not.toBeNull()
    expect(state!.locked_until).toBeNull()
  })

  test("tryAcquire claims the lock and returns the persisted cursor", async () => {
    const lock = makeLock()
    await lock.ensureRow()

    const claim = await lock.tryAcquire()
    expect(claim).not.toBeNull()
    expect(claim!.lastEventId).toBeNull()
    expect(claim!.lastEventAt).toBeNull()

    const state = await getState()
    expect(state!.locked_until).not.toBeNull()
    expect(state!.lock_run_id).not.toBeNull()

    await lock.release()
    const after = await getState()
    expect(after!.locked_until).toBeNull()
    expect(after!.lock_run_id).toBeNull()
  })

  test("a second instance cannot claim while the first holds the lock", async () => {
    const lockA = makeLock()
    const lockB = makeLock()
    await lockA.ensureRow()

    const claimA = await lockA.tryAcquire()
    expect(claimA).not.toBeNull()

    const claimB = await lockB.tryAcquire()
    expect(claimB).toBeNull()

    await lockA.release()

    const claimBAfter = await lockB.tryAcquire()
    expect(claimBAfter).not.toBeNull()
    await lockB.release()
  })

  test("a second instance can claim after the lease expires", async () => {
    const lockA = makeLock({ lockDurationMs: 50 })
    const lockB = makeLock({ lockDurationMs: 50 })
    await lockA.ensureRow()

    const claimA = await lockA.tryAcquire()
    expect(claimA).not.toBeNull()

    // Force the lease to expire by rewriting locked_until in the past.
    await pool.query(
      "UPDATE workos_event_poller_state SET locked_until = NOW() - INTERVAL '1 second' WHERE name = $1",
      [lockName]
    )

    const claimB = await lockB.tryAcquire()
    expect(claimB).not.toBeNull()
    await lockB.release()
  })

  test("advance persists the cursor and resets retry state", async () => {
    const lock = makeLock()
    await lock.ensureRow()

    // Force a retry state then advance should clear it.
    await pool.query(
      "UPDATE workos_event_poller_state SET retry_count = 2, retry_after = NOW() - INTERVAL '1 hour', last_error = 'boom' WHERE name = $1",
      [lockName]
    )

    const claim = await lock.tryAcquire()
    expect(claim).not.toBeNull()

    const eventAt = new Date("2026-01-01T00:00:00Z")
    await lock.advance("event_42", eventAt)

    const state = await getState()
    expect(state!.last_event_id).toBe("event_42")
    expect(state!.last_event_at!.toISOString()).toBe(eventAt.toISOString())
    expect(state!.retry_count).toBe(0)
    expect(state!.retry_after).toBeNull()
    expect(state!.last_error).toBeNull()

    await lock.release()
  })

  test("advance is a no-op when lock_run_id has been taken over", async () => {
    const lock = makeLock()
    await lock.ensureRow()
    const claim = await lock.tryAcquire()
    expect(claim).not.toBeNull()

    // Simulate another instance stealing the lock after lease expiry.
    await pool.query(
      "UPDATE workos_event_poller_state SET lock_run_id = 'other-run-id', locked_until = NOW() + INTERVAL '1 minute' WHERE name = $1",
      [lockName]
    )

    await lock.advance("event_42", new Date())

    const state = await getState()
    expect(state!.last_event_id).toBeNull()
  })

  test("recordError applies exponential backoff and stops retrying after maxRetries", async () => {
    const lock = makeLock({ maxRetries: 2, baseBackoffMs: 100 })
    await lock.ensureRow()
    // recordError is guarded by lock_run_id, so the lease must be held first.
    const claim = await lock.tryAcquire()
    expect(claim).not.toBeNull()

    const r1 = await lock.recordError("first")
    expect(r1.shouldRetry).toBe(true)
    let state = await getState()
    expect(state!.retry_count).toBe(1)
    expect(state!.retry_after).not.toBeNull()
    expect(state!.last_error).toBe("first")

    const r2 = await lock.recordError("second")
    expect(r2.shouldRetry).toBe(true)
    state = await getState()
    expect(state!.retry_count).toBe(2)

    const r3 = await lock.recordError("third")
    expect(r3.shouldRetry).toBe(false)

    await lock.release()
  })

  test("isReadyToProcess gates tryAcquire on retry_after", async () => {
    const lock = makeLock()
    await lock.ensureRow()
    await pool.query("UPDATE workos_event_poller_state SET retry_after = NOW() + INTERVAL '1 hour' WHERE name = $1", [
      lockName,
    ])

    const blocked = await lock.tryAcquire()
    expect(blocked).toBeNull()
  })

  test("stampBackfill stamps last_backfill_at without claiming the lock", async () => {
    const lock = makeLock()
    await lock.ensureRow()

    await lock.stampBackfill()
    const state = await getState()
    expect(state!.last_backfill_at).not.toBeNull()
    expect(state!.locked_until).toBeNull()
  })

  // refreshLock is timer-driven in production; calling it directly pins the interleaving.
  function refresh(lock: WorkosEventPollerLock): Promise<void> {
    return (lock as unknown as { refreshLock(): Promise<void> }).refreshLock()
  }

  test("a refresh landing after release does not report the lease lost", async () => {
    let openGate!: () => void
    const gate = new Promise<void>((resolve) => (openGate = resolve))
    let holdNextQuery = false
    const gatedPool = {
      query: async (...args: Parameters<Pool["query"]>) => {
        if (holdNextQuery) {
          holdNextQuery = false
          await gate
        }
        return pool.query(...args)
      },
    } as unknown as Pool
    const lock = makeLock({ pool: gatedPool })
    await lock.ensureRow()
    expect(await lock.tryAcquire()).not.toBeNull()

    holdNextQuery = true
    const inFlight = refresh(lock)
    await lock.release()
    openGate()

    await expect(inFlight).resolves.toBeUndefined()
    const state = await getState()
    expect({ lockRunId: state!.lock_run_id, lockedUntil: state!.locked_until }).toEqual({
      lockRunId: null,
      lockedUntil: null,
    })
  })

  test("a refresh after another instance took the lease reports it lost", async () => {
    const lock = makeLock()
    await lock.ensureRow()
    expect(await lock.tryAcquire()).not.toBeNull()

    await pool.query(
      "UPDATE workos_event_poller_state SET lock_run_id = 'other-run-id', locked_until = NOW() + INTERVAL '1 minute' WHERE name = $1",
      [lockName]
    )

    await expect(refresh(lock)).rejects.toThrow(`Lost WorkOS event poller lease for ${lockName}`)
  })

  test("release without holding the lock is a no-op", async () => {
    const lock = makeLock()
    await lock.ensureRow()

    await lock.release()
    const state = await getState()
    expect(state!.locked_until).toBeNull()
  })
})
