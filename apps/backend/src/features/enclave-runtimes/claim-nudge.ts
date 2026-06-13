import type { Pool, PoolClient } from "pg"
import type { Querier } from "../../db"
import { logger as baseLogger } from "../../lib/logger"

const logger = baseLogger.child({ name: "enclave-claim-nudge" })

/**
 * Postgres NOTIFY channel that says "a claimable enclave invocation now exists".
 * A doorbell, not a delivery: the durable work item is the `enclave_invocations`
 * row, and a long-poll's timeout fetches it directly even if the nudge is missed,
 * so this stays best-effort (the same shape as the outbox dispatcher's LISTEN).
 */
export const ENCLAVE_INVOCATION_CHANNEL = "enclave_invocation_available"

/**
 * Ring the doorbell after enqueuing work. Postgres NOTIFY is transactional —
 * delivered at commit and dropped on rollback — so on a pool connection
 * (autocommit, the live callers) it fires once the inserted row is visible, and
 * inside a transaction it would ride the same commit as the insert. Either way a
 * woken instance never races ahead of the row. Channel is a fixed identifier —
 * no interpolation risk.
 */
export async function notifyEnclaveInvocationAvailable(db: Querier): Promise<void> {
  await db.query(`NOTIFY ${ENCLAVE_INVOCATION_CHANNEL}`)
}

/**
 * The wait side of the wake-up nudge that the claim long-poll parks on. Kept as
 * an interface so the handler depends on the capability, not the LISTEN plumbing
 * (and tests can drive it without a database).
 */
export interface EnclaveClaimWaiter {
  /**
   * Resolve when the next invocation nudge arrives, the timeout elapses, or the
   * signal aborts — whichever comes first. Never rejects. Returns `false` only
   * when the nudge has been stopped (shutdown), so a parked long-poll gives up
   * and answers 204 instead of re-parking on a timer the torn-down listener
   * can't cut short; `true` otherwise, leaving the caller to re-check its own
   * deadline/abort and re-attempt the claim.
   */
  waitForInvocation(opts: { timeoutMs: number; signal?: AbortSignal }): Promise<boolean>
}

/**
 * Holds one LISTEN connection on `ENCLAVE_INVOCATION_CHANNEL` and fans each
 * notification out to the in-process waiters (the parked claim long-polls). One
 * connection serves every concurrent long-poll on this backend process, so a
 * held HTTP request never pins a DB connection (INV-41) — it waits on an
 * in-memory signal that the single listener feeds.
 *
 * Mirrors `OutboxDispatcher`'s LISTEN robustness (keepalive + reconnect). While
 * the listener is down, nudges are missed but correctness holds: every parked
 * long-poll still times out and re-polls, finding the row directly. The nudge is
 * an optimization, not a dependency.
 */
export class EnclaveClaimNudge implements EnclaveClaimWaiter {
  private readonly listenPool: Pool
  private readonly keepaliveMs: number
  private client: PoolClient | null = null
  private running = false
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null
  private readonly waiters = new Set<(live: boolean) => void>()

  constructor(deps: { listenPool: Pool; keepaliveMs?: number }) {
    this.listenPool = deps.listenPool
    this.keepaliveMs = deps.keepaliveMs ?? 30_000
  }

  async start(): Promise<void> {
    this.running = true
    await this.setupListener()
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer)
      this.keepaliveTimer = null
    }
    // Release parked long-polls with `false` so their requests answer 204 now
    // instead of re-parking on a timer this torn-down listener can no longer cut
    // short — otherwise they'd hang graceful shutdown for the whole budget.
    this.wakeAll(false)
    if (this.client) {
      try {
        this.client.release()
      } catch {
        // Ignore release errors during shutdown.
      }
      this.client = null
    }
  }

  waitForInvocation({ timeoutMs, signal }: { timeoutMs: number; signal?: AbortSignal }): Promise<boolean> {
    if (!this.running) return Promise.resolve(false)
    if (timeoutMs <= 0 || signal?.aborted) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      let settled = false
      const settle = (live: boolean) => {
        if (settled) return
        settled = true
        this.waiters.delete(settle)
        clearTimeout(timer)
        signal?.removeEventListener("abort", onAbort)
        resolve(live)
      }
      // A nudge, a timeout, or an abort all just mean "re-check and re-claim";
      // only stop() (via wakeAll(false)) resolves a parked waiter as dead.
      const onAbort = () => settle(true)
      const timer = setTimeout(() => settle(true), timeoutMs)
      this.waiters.add(settle)
      signal?.addEventListener("abort", onAbort, { once: true })
    })
  }

  private wakeAll(live: boolean): void {
    if (this.waiters.size === 0) return
    const pending = [...this.waiters]
    this.waiters.clear()
    for (const settle of pending) settle(live)
  }

  private async setupListener(): Promise<void> {
    try {
      this.client = await this.listenPool.connect()
      this.client.on("notification", () => this.wakeAll(true))
      this.client.on("error", (err: Error) => {
        if (!this.running) return
        logger.error({ err }, "Enclave claim nudge LISTEN error; reconnecting")
        this.reconnect()
      })
      await this.client.query(`LISTEN ${ENCLAVE_INVOCATION_CHANNEL}`)
      this.startKeepalive()
      logger.debug("Enclave claim nudge LISTEN established")
    } catch (err) {
      logger.error({ err }, "Enclave claim nudge failed to LISTEN")
      this.scheduleReconnect()
    }
  }

  private startKeepalive(): void {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer)
    this.keepaliveTimer = setInterval(async () => {
      if (!this.client || !this.running) return
      try {
        await this.client.query("SELECT 1")
      } catch (err) {
        // The client's error handler drives the reconnect; just trace it.
        logger.debug({ err }, "Enclave claim nudge keepalive failed")
      }
    }, this.keepaliveMs)
  }

  private reconnect(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer)
      this.keepaliveTimer = null
    }
    if (this.client) {
      try {
        this.client.release()
      } catch {
        // Ignore.
      }
      this.client = null
    }
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (!this.running) return
    setTimeout(() => {
      if (this.running) void this.setupListener()
    }, 1000)
  }
}
