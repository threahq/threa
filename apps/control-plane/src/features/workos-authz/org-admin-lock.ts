import { createHash } from "crypto"
import type { Pool } from "pg"
import { HttpError } from "@threahq/backend-common"

/**
 * Serialize WorkOS admin writes for a single organization across CP instances.
 *
 * The `WorkosAuthzAdminService` guards (last-owner, actor-is-owner) read state
 * and then mutate WorkOS. Without serialization, two concurrent demote calls
 * each see "two owners remain", both pass the guard, and WorkOS ends up with
 * zero owners. Holding a lock keyed on the WorkOS organization id for the
 * full read-guard-write sequence closes that window.
 *
 * Implementation: `pg_try_advisory_lock` on a dedicated pool client, polled
 * with backoff until acquired or `LOCK_WAIT_BUDGET_MS` elapses. The lock
 * client does no other work while held, so the in-tick WorkOS call does not
 * block any transactional pool connection — only the lock client itself sits
 * idle holding the kernel-level lock. Admin writes are low-frequency
 * human-triggered actions and the held window is bounded by WorkOS API
 * latency (sub-second p50), so connection-pool starvation is not a concern.
 *
 * Why advisory locks here and not the time-based lease pattern used elsewhere
 * (`WorkosEventPollerLock`, `CursorLock`): leases shine for long-lived
 * leader-election ("which CP instance polls?") where lease handover and crash
 * recovery matter. This is the opposite case — per-request, short-lived,
 * request-scoped mutual exclusion — where postgres's built-in lock primitives
 * do the right thing for free.
 */
const LOCK_WAIT_BUDGET_MS = 10_000
const POLL_INTERVAL_MS = 100

export async function withOrganizationAdminLock<T>(
  pool: Pool,
  organizationId: string,
  fn: () => Promise<T>
): Promise<T> {
  const [key1, key2] = organizationIdToLockKeys(organizationId)
  const client = await pool.connect()
  try {
    const deadline = Date.now() + LOCK_WAIT_BUDGET_MS
    let acquired = false
    while (!acquired) {
      const result = await client.query<{ pg_try_advisory_lock: boolean }>("SELECT pg_try_advisory_lock($1, $2)", [
        key1,
        key2,
      ])
      acquired = result.rows[0]?.pg_try_advisory_lock === true
      if (!acquired) {
        if (Date.now() >= deadline) {
          throw new HttpError("Another admin operation is in progress; retry in a moment", {
            status: 503,
            code: "ADMIN_LOCK_HELD",
          })
        }
        await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
      }
    }
    try {
      return await fn()
    } finally {
      await client.query("SELECT pg_advisory_unlock($1, $2)", [key1, key2])
    }
  } finally {
    client.release()
  }
}

/**
 * Hash a WorkOS org id (opaque string) into the two-int form
 * `pg_advisory_lock(int, int)` expects. SHA-256 → two signed int32s gives a
 * 64-bit keyspace; collision probability across realistic org counts is
 * negligible, and a collision would only serialize two unrelated orgs (a
 * tiny correctness-neutral perf cost).
 */
function organizationIdToLockKeys(organizationId: string): [number, number] {
  const digest = createHash("sha256").update(organizationId).digest()
  return [digest.readInt32BE(0), digest.readInt32BE(4)]
}
