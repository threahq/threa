/**
 * Fence for work that outlives the render tree it started in — the outbox
 * drain, the operation queue, an upload transfer. Each unit is owned by the
 * account that formed it, but the credential it travels on (the session
 * cookie) and the database it writes to (the `db` proxy) are process-wide and
 * move on an account switch. Without a fence, a send composed by account A
 * lands as account B, and B's database grows A's rows.
 *
 * A switch calls {@link retireAccountWork} *before* the credential moves, so
 * work in flight is told to stop and gets a bounded chance to settle under its
 * own account. Past that bound the credential has moved, which is why units
 * also check {@link AccountWorkFence.isRetired} after every await that can span
 * the switch: a straggler must stop before its next write rather than publish
 * into the account that replaced it. The server-side assertion
 * (`ACCOUNT_ASSERTION_HEADER`) is the backstop for a request already on the
 * wire at that moment.
 */

import { getAccountAssertionGeneration } from "@/api/account-assertion"

/** How long a switch waits for in-flight account work to settle. */
const RETIRE_TIMEOUT_MS = 3000

export interface AccountWorkFence {
  /** True once the account that formed this work is no longer the active one. */
  isRetired(): boolean
}

let epoch = 0
const inFlight = new Set<Promise<unknown>>()

/**
 * Run a unit of account-owned work under the current account's fence. The
 * returned promise is what a retiring switch waits on, so keep the unit to
 * work the account actually owns (a queue drain, one transfer), not an
 * indefinite subscription.
 */
export function runAccountOwnedWork<T>(run: (fence: AccountWorkFence) => Promise<T>): Promise<T> {
  const startedAt = epoch
  const accountGeneration = getAccountAssertionGeneration()
  const fence: AccountWorkFence = {
    // Identity equality misses an A → B → A round trip while work is awaiting.
    isRetired: () => epoch !== startedAt || getAccountAssertionGeneration() !== accountGeneration,
  }
  const work = Promise.resolve(run(fence)).finally(() => {
    inFlight.delete(work)
  })
  inFlight.add(work)
  return work
}

/**
 * Retire the outgoing account's in-flight work and wait for it to settle.
 * Called before the credential and the active database move. Returns after
 * {@link RETIRE_TIMEOUT_MS} regardless — a switch the user asked for is not
 * held hostage by a stalled request.
 */
export async function retireAccountWork(timeoutMs: number = RETIRE_TIMEOUT_MS): Promise<void> {
  epoch += 1
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    Promise.allSettled([...inFlight]),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
    }),
  ])
  clearTimeout(timer)
}
