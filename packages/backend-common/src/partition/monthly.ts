import type { PoolClient } from "pg"
import type { Querier } from "../db/index"

/**
 * Pure monthly range-partition helpers for declaratively-partitioned tables
 * (PG 17). Boundaries are UTC month starts of the partition key; a row's
 * `occurred_at` sorts into `<parent>_YYYY_MM` for the month it falls in.
 *
 * All operations are idempotent (IF NOT EXISTS / IF EXISTS) and safe to run on
 * every pod without leader election — same rationale as the sync/outbox
 * retention sweeps.
 */

export interface EnsurePartitionsOptions {
  /** Number of future months to create beyond the current one. */
  aheadMonths: number
}

export interface DropExpiredOptions {
  /** Months of history to retain; older partitions are dropped. */
  retainMonths: number
  /** Reference "now"; defaults to the current time. Injected for tests. */
  now?: Date
}

interface MonthBounds {
  /** Inclusive lower bound, `YYYY-MM-01`. */
  from: string
  /** Exclusive upper bound (first day of the next month), `YYYY-MM-01`. */
  to: string
}

/**
 * Parent names are interpolated into DDL identifiers and a drop-guard RegExp,
 * so only a strict lowercase snake_case identifier is accepted — anything else
 * fails loudly before touching the catalog.
 */
function assertSafeParentName(parent: string): void {
  if (!/^[a-z_][a-z0-9_]*$/.test(parent)) {
    throw new Error(`partition parent name must match ^[a-z_][a-z0-9_]*$, got: ${parent}`)
  }
}

function utcMonthStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1))
}

function addMonths(monthStart: Date, months: number): Date {
  return new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + months, 1))
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/** `<parent>_YYYY_MM` for the UTC month containing `date`. */
export function monthlyPartitionName(parent: string, date: Date): string {
  const start = utcMonthStart(date)
  const yyyy = String(start.getUTCFullYear()).padStart(4, "0")
  const mm = String(start.getUTCMonth() + 1).padStart(2, "0")
  return `${parent}_${yyyy}_${mm}`
}

/** Half-open UTC month bounds `[from, to)` for the month containing `date`. */
export function monthlyPartitionBounds(date: Date): MonthBounds {
  const start = utcMonthStart(date)
  return { from: isoDate(start), to: isoDate(addMonths(start, 1)) }
}

/**
 * Create the current month partition plus `aheadMonths` future ones. Idempotent
 * — re-running is a no-op once the partitions exist.
 */
export async function ensureMonthlyPartitions(
  querier: Querier,
  parent: string,
  options: EnsurePartitionsOptions
): Promise<void> {
  assertSafeParentName(parent)
  const base = utcMonthStart(new Date())
  for (let i = 0; i <= options.aheadMonths; i++) {
    const monthStart = addMonths(base, i)
    const name = monthlyPartitionName(parent, monthStart)
    // +00-anchored literals so boundaries are UTC regardless of the session
    // TimeZone GUC (a bare date literal would coerce to session-local midnight).
    const from = `${isoDate(monthStart)} 00:00:00+00`
    const to = `${isoDate(addMonths(monthStart, 1))} 00:00:00+00`
    await runDdlWithLockTimeout(
      querier,
      `CREATE TABLE IF NOT EXISTS "${name}" PARTITION OF "${parent}" FOR VALUES FROM ('${from}') TO ('${to}')`
    )
  }
}

/**
 * Partition create/drop takes ACCESS EXCLUSIVE on the parent. Without a lock
 * timeout, the DDL queuing behind a long forensic read would in turn queue
 * every fire-and-forget audit insert behind itself — pool exhaustion from a
 * maintenance tick. Bounded wait + throw lets the worker retry next tick.
 *
 * BEGIN/SET LOCAL/DDL must share one connection, and a failed DDL must be
 * ROLLBACKed on that same connection — a pooled connection returned with an
 * aborted transaction would poison its next checkout.
 */
async function runDdlWithLockTimeout(querier: Querier, ddl: string): Promise<void> {
  // `connect` duck-typing would misfire: pg's Client also has .connect(), and
  // calling it on an already-connected PoolClient throws. Pool is detected by
  // its pool-only counters instead.
  const isPool = typeof (querier as { connect?: unknown }).connect === "function" && "totalCount" in (querier as object)
  const acquired = isPool ? await (querier as unknown as { connect(): Promise<PoolClient> }).connect() : null
  const client = acquired ?? (querier as PoolClient)
  try {
    await client.query("BEGIN")
    await client.query("SET LOCAL lock_timeout = '5s'")
    await client.query(ddl)
    await client.query("COMMIT")
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {})
    throw err
  } finally {
    acquired?.release()
  }
}

/**
 * Drop partitions of `parent` whose month is older than `retainMonths` before
 * the current month. Only tables matching the strict `^<parent>_\d{4}_\d{2}$`
 * pattern are ever dropped — a hard guard against dropping anything but a
 * genuine monthly partition of this parent.
 */
export async function dropExpiredMonthlyPartitions(
  querier: Querier,
  parent: string,
  options: DropExpiredOptions
): Promise<string[]> {
  assertSafeParentName(parent)
  const now = options.now ?? new Date()
  const cutoff = addMonths(utcMonthStart(now), -options.retainMonths)
  const namePattern = new RegExp(`^${parent}_(\\d{4})_(\\d{2})$`)

  const existing = await querier.query<{ child: string }>(
    `SELECT c.relname AS child
       FROM pg_inherits i
       JOIN pg_class c ON c.oid = i.inhrelid
       JOIN pg_class p ON p.oid = i.inhparent
      WHERE p.relname = $1`,
    [parent]
  )

  const dropped: string[] = []
  for (const { child } of existing.rows) {
    const match = namePattern.exec(child)
    if (!match) continue
    const monthStart = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1))
    if (monthStart < cutoff) {
      await runDdlWithLockTimeout(querier, `DROP TABLE IF EXISTS "${child}"`)
      dropped.push(child)
    }
  }
  return dropped
}
