import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase, setupIsolatedTestDatabase } from "./setup"
import { ensureMonthlyPartitions, dropExpiredMonthlyPartitions, monthlyPartitionName } from "@threahq/backend-common"
import { AccessLogService } from "../../src/features/access-log"
import { AccessLogRepository } from "../../src/features/access-log"

describe("AccessLogService round-trip", () => {
  let pool: Pool
  let service: AccessLogService
  const ws = `ws_acc_${Date.now()}`
  const actor = `usr_acc_${Date.now()}`

  beforeAll(async () => {
    pool = await setupTestDatabase()
    service = new AccessLogService({ pool })
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query("DELETE FROM access_log WHERE workspace_id = $1 OR actor_id = $2", [ws, actor])
  })

  test("recordSync persists a row queryable by actor, workspace-scoped", async () => {
    await service.recordSync(pool, {
      workspaceId: ws,
      actorType: "user",
      actorId: actor,
      operation: "streams.bootstrap",
      accessKind: "read",
      outcome: "success",
      subjects: [{ type: "stream", id: "stream_a", fromSeq: 1, toSeq: 42 }],
      detail: { note: "test" },
      ip: "203.0.113.7",
      userAgent: "test-agent",
      requestId: "req_1",
    })

    const byActor = await service.listByActor({ workspaceId: ws, actorId: actor })
    expect(byActor).toHaveLength(1)
    expect(byActor[0]).toMatchObject({
      workspaceId: ws,
      actorType: "user",
      actorId: actor,
      operation: "streams.bootstrap",
      accessKind: "read",
      outcome: "success",
      ip: "203.0.113.7",
      userAgent: "test-agent",
      requestId: "req_1",
      subjects: [{ type: "stream", id: "stream_a", fromSeq: 1, toSeq: 42 }],
    })
    expect(byActor[0].id).toMatch(/^acc_/)

    // Different workspace must not see the row.
    const otherWs = await service.listByActor({ workspaceId: "ws_other", actorId: actor })
    expect(otherWs).toHaveLength(0)
  })

  test("listBySubject finds rows via GIN containment, workspace-scoped", async () => {
    await AccessLogRepository.insertMany(pool, [
      {
        id: `acc_test_a_${Date.now()}`,
        workspaceId: ws,
        actorType: "user",
        actorId: actor,
        operation: "search.messages",
        accessKind: "read",
        outcome: "success",
        subjects: [
          { type: "message", id: "msg_1" },
          { type: "message", id: "msg_2" },
        ],
      },
      {
        id: `acc_test_b_${Date.now()}`,
        workspaceId: ws,
        actorType: "user",
        actorId: actor,
        operation: "memos.read",
        accessKind: "read",
        outcome: "success",
        subjects: [{ type: "memo", id: "memo_9" }],
      },
    ])

    const touchedMsg1 = await service.listBySubject({
      workspaceId: ws,
      subjectType: "message",
      subjectId: "msg_1",
    })
    expect(touchedMsg1).toHaveLength(1)
    expect(touchedMsg1[0].operation).toBe("search.messages")

    const touchedMemo = await service.listBySubject({
      workspaceId: ws,
      subjectType: "memo",
      subjectId: "memo_9",
    })
    expect(touchedMemo).toHaveLength(1)

    // Wrong workspace scope returns nothing even though the subject matches.
    const wrongWs = await service.listBySubject({
      workspaceId: "ws_other",
      subjectType: "message",
      subjectId: "msg_1",
    })
    expect(wrongWs).toHaveLength(0)
  })

  test("sanitizes garbage ip and request id instead of losing the row", async () => {
    await service.recordSync(pool, {
      workspaceId: ws,
      actorType: "user",
      actorId: actor,
      operation: "streams.bootstrap",
      accessKind: "read",
      outcome: "denied",
      ip: "not-an-ip",
      requestId: "an email@example.com smuggled as a request id with spaces",
    })
    const rows = await service.listByActor({ workspaceId: ws, actorId: actor })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ outcome: "denied", ip: null, requestId: null })
  })

  test("accepts a NULL-workspace auth-surface row", async () => {
    await service.recordSync(pool, {
      workspaceId: null,
      actorType: "user",
      actorId: actor,
      operation: "workspace.bootstrap",
      accessKind: "read",
      outcome: "denied",
    })
    const rows = await service.listByActor({ workspaceId: null, actorId: actor })
    expect(rows).toHaveLength(1)
    expect(rows[0].workspaceId).toBeNull()
    expect(rows[0].outcome).toBe("denied")
  })

  test("caps subjects at 100 with an overflow tail", async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ type: "message", id: `msg_${i}` }))
    await service.recordSync(pool, {
      workspaceId: ws,
      actorType: "user",
      actorId: actor,
      operation: "search.messages",
      accessKind: "read",
      outcome: "success",
      subjects: many,
    })
    const rows = await service.listByActor({ workspaceId: ws, actorId: actor })
    expect(rows).toHaveLength(1)
    const subjects = rows[0].subjects!
    // Total stays within SUBJECTS_CAP (100): 99 kept refs + the overflow marker,
    // whose count includes the ref displaced to make room (150 - 99 = 51).
    expect(subjects).toHaveLength(100)
    expect(subjects[99]).toEqual({ type: "overflow", count: 51 })
  })
})

describe("access_log partition lifecycle", () => {
  let pool: Pool
  let cleanup: () => Promise<void>

  beforeAll(async () => {
    const isolated = await setupIsolatedTestDatabase("access-log-partition")
    pool = isolated.pool
    cleanup = isolated.cleanup
  })

  afterAll(async () => {
    await cleanup()
  })

  async function partitionExists(name: string): Promise<boolean> {
    const res = await pool.query("SELECT to_regclass($1) AS oid", [name])
    return res.rows[0].oid !== null
  }

  test("migration seeded the current + next month partitions", async () => {
    const now = new Date()
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
    expect(await partitionExists(monthlyPartitionName("access_log", now))).toBe(true)
    expect(await partitionExists(monthlyPartitionName("access_log", next))).toBe(true)
  })

  test("ensureMonthlyPartitions is idempotent and provisions ahead", async () => {
    await ensureMonthlyPartitions(pool, "access_log", { aheadMonths: 2 })
    await ensureMonthlyPartitions(pool, "access_log", { aheadMonths: 2 })

    const now = new Date()
    const twoAhead = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 1))
    expect(await partitionExists(monthlyPartitionName("access_log", twoAhead))).toBe(true)
  })

  test("dropExpiredMonthlyPartitions removes only expired matching-pattern partitions", async () => {
    // An old partition (2 years back) that must be dropped, and a look-alike
    // non-partition table that must survive the strict name-pattern guard.
    const oldMonth = new Date()
    oldMonth.setUTCFullYear(oldMonth.getUTCFullYear() - 2)
    const oldName = monthlyPartitionName("access_log", oldMonth)
    const oldFrom = new Date(Date.UTC(oldMonth.getUTCFullYear(), oldMonth.getUTCMonth(), 1)).toISOString().slice(0, 10)
    const oldTo = new Date(Date.UTC(oldMonth.getUTCFullYear(), oldMonth.getUTCMonth() + 1, 1))
      .toISOString()
      .slice(0, 10)
    await pool.query(
      `CREATE TABLE IF NOT EXISTS "${oldName}" PARTITION OF access_log FOR VALUES FROM ('${oldFrom}') TO ('${oldTo}')`
    )
    await pool.query(`CREATE TABLE IF NOT EXISTS access_log_backup (id TEXT)`)

    const currentName = monthlyPartitionName("access_log", new Date())
    expect(await partitionExists(oldName)).toBe(true)

    const dropped = await dropExpiredMonthlyPartitions(pool, "access_log", { retainMonths: 13 })

    expect(dropped).toContain(oldName)
    expect(await partitionExists(oldName)).toBe(false)
    expect(await partitionExists(currentName)).toBe(true)
    expect(await partitionExists("access_log_backup")).toBe(true)

    await pool.query(`DROP TABLE IF EXISTS access_log_backup`)
  })

  test("an inserted row routes into the correct monthly partition", async () => {
    // One controlled timestamp for both the insert and the expected partition
    // name — mid-current-UTC-month so the row lands in a seeded partition and
    // the assertion can't straddle a month boundary (PG now() vs JS new Date()).
    const nowUtc = new Date()
    const occurredAt = new Date(Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), 15, 12))
    await pool.query(
      `INSERT INTO access_log (id, workspace_id, occurred_at, actor_type, actor_id, operation, access_kind, outcome)
       VALUES ($1, $2, $3, 'user', $4, 'streams.catchup', 'read', 'success')`,
      [`acc_route_${Date.now()}`, "ws_route", occurredAt.toISOString(), "usr_route"]
    )
    const partition = monthlyPartitionName("access_log", occurredAt)
    const res = await pool.query(`SELECT count(*)::int AS n FROM "${partition}" WHERE actor_id = 'usr_route'`)
    expect(res.rows[0].n).toBe(1)
  })
})
