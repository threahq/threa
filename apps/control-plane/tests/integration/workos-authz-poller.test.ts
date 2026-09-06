import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import type { Pool } from "pg"
import { StubWorkosOrgService, type WorkosMembershipEvent } from "@threahq/backend-common"
import { WorkosAuthzRepository, WorkosAuthzPoller, WorkosAuthzService } from "../../src/features/workos-authz"
import { WorkosEventPollerLock } from "../../src/lib/workos-event-poller-lock"
import { setupTestDatabase } from "./setup"

describe("WorkosAuthzPoller", () => {
  let pool: Pool
  const orgId = "org_test_authz_poller"
  const userId = "user_test_authz_poller"
  const lockName = "test-workos-events-poller"

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query("DELETE FROM workos_event_poller_state WHERE name = $1", [lockName])
    await pool.query("DELETE FROM workos_organization_memberships WHERE workos_organization_id = $1", [orgId])
  })

  afterEach(() => {
    mock.restore()
  })

  function makeEvent(
    id: string,
    type: WorkosMembershipEvent["type"],
    createdAt: Date,
    overrides: Partial<{ status: string; roleSlugs: string[] }> = {}
  ): WorkosMembershipEvent {
    return {
      id,
      type,
      createdAt,
      membership: {
        id: "om_1",
        organizationId: orgId,
        userId,
        status: (overrides.status as WorkosMembershipEvent["membership"]["status"]) ?? "active",
        roleSlugs: overrides.roleSlugs ?? ["member"],
        updatedAt: createdAt,
      },
    }
  }

  function makeStack({
    pollIntervalMs = 50,
    batchSize = 10,
    lockDurationMs = 5_000,
  }: { pollIntervalMs?: number; batchSize?: number; lockDurationMs?: number } = {}) {
    const stub = new StubWorkosOrgService()
    const lock = new WorkosEventPollerLock({
      pool,
      name: lockName,
      lockDurationMs,
      refreshIntervalMs: 1_000,
      maxRetries: 3,
      baseBackoffMs: 100,
    })
    const service = new WorkosAuthzService({ pool })
    const poller = new WorkosAuthzPoller({
      workosOrgService: stub,
      authzService: service,
      lock,
      pollIntervalMs,
      batchSize,
    })
    return { stub, lock, service, poller }
  }

  test("happy path: drains pages, processes each event, advances cursor", async () => {
    const { stub, lock, poller } = makeStack({ batchSize: 2 })
    await lock.ensureRow()

    const t0 = new Date("2026-01-01T00:00:00Z")
    const t1 = new Date("2026-01-01T00:00:01Z")
    const t2 = new Date("2026-01-01T00:00:02Z")
    stub.pushMirrorEvent(makeEvent("event_01", "organization_membership.created", t0))
    stub.pushMirrorEvent(makeEvent("event_02", "organization_membership.updated", t1, { roleSlugs: ["admin"] }))
    stub.pushMirrorEvent(makeEvent("event_03", "organization_membership.updated", t2, { roleSlugs: ["owner"] }))

    await poller.tick()

    const row = await WorkosAuthzRepository.getByOrgAndUser(pool, orgId, userId)
    expect(row).toMatchObject({ role_slugs: ["owner"], last_event_id: "event_03" })

    const cursor = await pool.query<{ last_event_id: string | null; locked_until: Date | null }>(
      "SELECT last_event_id, locked_until FROM workos_event_poller_state WHERE name = $1",
      [lockName]
    )
    expect(cursor.rows[0]).toMatchObject({ last_event_id: "event_03", locked_until: null })
  })

  test("no-events tick: claims, drains nothing, releases", async () => {
    const { lock, poller } = makeStack()
    await lock.ensureRow()

    await poller.tick()

    const state = await pool.query<{ last_event_id: string | null; locked_until: Date | null }>(
      "SELECT last_event_id, locked_until FROM workos_event_poller_state WHERE name = $1",
      [lockName]
    )
    expect(state.rows[0]).toMatchObject({ last_event_id: null, locked_until: null })
  })

  test("error path: records error and releases the lock", async () => {
    const { stub, lock, poller } = makeStack()
    await lock.ensureRow()

    const boom = new Error("WorkOS unavailable")
    stub.listMirrorEvents = mock(async () => {
      throw boom
    }) as typeof stub.listMirrorEvents

    await poller.tick()

    const state = await pool.query<{
      retry_count: number
      retry_after: Date | null
      last_error: string | null
      locked_until: Date | null
    }>("SELECT retry_count, retry_after, last_error, locked_until FROM workos_event_poller_state WHERE name = $1", [
      lockName,
    ])
    expect(state.rows[0]).toMatchObject({
      retry_count: 1,
      last_error: "WorkOS unavailable",
      locked_until: null,
    })
    expect(state.rows[0].retry_after).not.toBeNull()
  })

  test("lock contention: a second poller's tick is a no-op while the first holds", async () => {
    const stack1 = makeStack()
    const stack2 = makeStack()
    await stack1.lock.ensureRow()

    const t0 = new Date("2026-01-01T00:00:00Z")
    stack2.stub.pushMirrorEvent(makeEvent("event_01", "organization_membership.created", t0))

    // Stack 1 claims and holds the lock by manually claiming without releasing.
    const claim = await stack1.lock.tryAcquire()
    expect(claim).not.toBeNull()

    try {
      // Stack 2's tick should be a no-op because the lock is held.
      await stack2.poller.tick()

      const row = await WorkosAuthzRepository.getByOrgAndUser(pool, orgId, userId)
      expect(row).toBeNull()
    } finally {
      await stack1.lock.release()
    }
  })

  test("stop waits for an in-flight tick to settle", async () => {
    // Long pollIntervalMs guarantees only the immediate first tick runs before
    // we call stop(). The first tick is scheduled at delay=0 in start().
    const { stub, lock, poller } = makeStack({ pollIntervalMs: 60_000 })
    await lock.ensureRow()

    const t0 = new Date("2026-01-01T00:00:00Z")
    stub.pushMirrorEvent(makeEvent("event_01", "organization_membership.created", t0))

    poller.start()
    // Give the scheduled tick a moment to start.
    await new Promise((r) => setTimeout(r, 50))
    await poller.stop()

    // After stop, the first tick should have completed and persisted state.
    const row = await WorkosAuthzRepository.getByOrgAndUser(pool, orgId, userId)
    expect(row).toMatchObject({ last_event_id: "event_01" })
  })
})
