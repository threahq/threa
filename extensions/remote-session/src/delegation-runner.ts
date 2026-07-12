import { ThreaApiError } from "./client"
import type { ClaimedDelegation, DelegationClient, DelegationSummary } from "./delegation-client"

const DEFAULT_POLL_MS = 60_000
/** Inside the server's 15-minute lease with two retries' worth of slack. */
const DEFAULT_HEARTBEAT_MS = 5 * 60 * 1000
/** The server's `errorMessage` validator cap (public-api schemas). */
const FAIL_MESSAGE_MAX = 1_000
/** The server's `statusNote` validator cap. */
const STATUS_NOTE_MAX = 2_000

export interface DelegationExecutorContext {
  /** Put a progress note on the card (also renews the lease). Best-effort. */
  reportStatus(note: string): Promise<void>
}

/**
 * The connector's only contribution: run the brief, return the result. Throw
 * to fail the delegation with the error's message. Returning nothing completes
 * without a result message.
 */
export type DelegationExecutor = (
  task: ClaimedDelegation,
  ctx: DelegationExecutorContext
) => Promise<{ resultMarkdown?: string; metadata?: Record<string, string> } | void>

export interface DelegationRunnerOptions {
  client: DelegationClient
  executor: DelegationExecutor
  /** Shown on the card while this runner holds the claim, e.g. "Kris's MacBook / Claude Code". */
  claimedByLabel: string
  /**
   * Durable-write hook for the claim idempotency key, awaited BEFORE the claim
   * request — persist it and a crash between the claim response and saving the
   * one-time token is recoverable (retrying with the key re-keys the claim).
   * Default: in-memory only (no crash recovery, still correct).
   */
  persistIdempotencyKey?: (delegationId: string, key: string) => void | Promise<void>
  /** Fallback poll interval. With a socket nudge wired, this is only a backstop. Default 60s. */
  pollMs?: number
  /** Lease renewal interval. Default 5 minutes against the 15-minute lease. */
  heartbeatMs?: number
  log?: (message: string) => void
}

/**
 * Drains the delegation queue for one runner (roadmap 5.4): nudge-or-poll →
 * claim → heartbeat → executor → complete/fail. The simple cousin of
 * `RemoteSession`'s claim drain — one delegation at a time, no busy-capability
 * split, no sealed variant (delegations never exist on E2E streams).
 *
 * Delivery: call `notifyAvailable()` from a `delegation:available` socket
 * nudge (`BotRuntimeTransport.onDelegationAvailable`) for instant pickup; the
 * poll timer is the headless fallback and the backstop for missed nudges.
 * Racing runners are safe by construction — the claim CAS picks one winner and
 * the rest see 409 and go back to sleep.
 */
export class DelegationRunner {
  private readonly client: DelegationClient
  private readonly executor: DelegationExecutor
  private readonly claimedByLabel: string
  private readonly persistIdempotencyKey?: DelegationRunnerOptions["persistIdempotencyKey"]
  private readonly pollMs: number
  private readonly heartbeatMs: number
  private readonly log: (message: string) => void

  private stopped = true
  /** The in-flight drain, when one is running — the single-flight latch. */
  private current: Promise<void> | undefined
  private pollTimer: ReturnType<typeof setInterval> | undefined

  constructor(opts: DelegationRunnerOptions) {
    this.client = opts.client
    this.executor = opts.executor
    this.claimedByLabel = opts.claimedByLabel
    this.persistIdempotencyKey = opts.persistIdempotencyKey
    this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS
    this.heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
    this.log = opts.log ?? (() => {})
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.pollTimer = setInterval(() => this.drain(), this.pollMs)
    this.drain()
  }

  /**
   * Resolves once the in-flight drain (if any) has finished, so a graceful
   * shutdown can reject its executor and still see the fail report posted.
   */
  stop(): Promise<void> {
    this.stopped = true
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = undefined
    return this.current ?? Promise.resolve()
  }

  /** Wire this to the `delegation:available` socket nudge for instant pickup. */
  notifyAvailable(): void {
    this.drain()
  }

  /**
   * Single-flight queue drain. While a delegation is executing, nudges and
   * poll ticks fall through — the re-list after each completion picks up
   * whatever accumulated, so nothing is lost, just serialized.
   */
  private drain(): void {
    if (this.stopped || this.current) return
    this.current = this.runDrain().finally(() => {
      this.current = undefined
    })
  }

  private async runDrain(): Promise<void> {
    try {
      let executed = true
      while (executed && !this.stopped) {
        executed = false
        const open = await this.client.listOpen()
        for (const summary of open) {
          if (this.stopped) return
          const claimed = await this.tryClaim(summary)
          if (!claimed) continue
          await this.execute(claimed)
          // One at a time: after finishing, re-list rather than working a
          // possibly-stale snapshot of the queue.
          executed = true
          break
        }
      }
    } catch (error) {
      this.log(`delegation drain failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async tryClaim(summary: DelegationSummary): Promise<ClaimedDelegation | null> {
    const idempotencyKey = crypto.randomUUID()
    await this.persistIdempotencyKey?.(summary.id, idempotencyKey)
    try {
      return await this.client.claim(summary.id, { claimedByLabel: this.claimedByLabel, idempotencyKey })
    } catch (error) {
      // 409: another runner won; 404: it vanished (cancelled) or we lost
      // access. Both mean "not ours" — move on quietly.
      if (error instanceof ThreaApiError && (error.status === 409 || error.status === 404)) return null
      throw error
    }
  }

  private async execute(task: ClaimedDelegation): Promise<void> {
    const { id, claimToken } = task
    const heartbeat = setInterval(() => {
      this.client.heartbeat(id, claimToken).catch((error) => {
        // A 404 means the claim is gone (cancelled under us, or expired); the
        // terminal complete/fail below will surface the same 404. Nothing to
        // do mid-execution — the executor cannot be safely interrupted.
        this.log(`delegation ${id} heartbeat failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }, this.heartbeatMs)

    const ctx: DelegationExecutorContext = {
      reportStatus: async (note: string) => {
        try {
          await this.client.reportStatus(id, claimToken, note.slice(0, STATUS_NOTE_MAX))
        } catch (error) {
          this.log(`delegation ${id} status report failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      },
    }

    try {
      const result = await this.executor(task, ctx)
      await this.client.complete(id, claimToken, {
        resultMarkdown: result?.resultMarkdown,
        metadata: result?.metadata,
      })
      this.log(`delegation ${id} completed`)
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, FAIL_MESSAGE_MAX)
      try {
        await this.client.fail(id, claimToken, message || "Delegation runner failed without a message")
      } catch (failError) {
        this.log(
          `delegation ${id} failed AND the fail report failed: ${
            failError instanceof Error ? failError.message : String(failError)
          }`
        )
      }
    } finally {
      clearInterval(heartbeat)
    }
  }
}
