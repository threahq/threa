import { ThreaApiError } from "./client"
import type { ClaimedDelegation, DelegationClient, DelegationSummary } from "./delegation-client"

const DEFAULT_POLL_MS = 60_000
const DEFAULT_HEARTBEAT_MS = 5 * 60 * 1000
const FAIL_MESSAGE_MAX = 1_000
const STATUS_NOTE_MAX = 2_000
const SHUTDOWN_WAIT_MS = 2_000
export const DELEGATION_STOP_REASON = "runner_shutdown"

export interface DelegationExecutorContext {
  signal: AbortSignal
  reportStatus(note: string): Promise<void>
}

export type DelegationExecutor = (
  task: ClaimedDelegation,
  ctx: DelegationExecutorContext
) => Promise<{ resultMarkdown?: string; metadata?: Record<string, string> } | void>

export interface DelegationRunnerOptions {
  client: DelegationClient
  executor: DelegationExecutor
  claimedByLabel: string
  persistIdempotencyKey?: (delegationId: string, key: string) => void | Promise<void>
  pollMs?: number
  heartbeatMs?: number
  /** Maximum controlled-stop wait. Primarily useful to bound host reconnects. */
  shutdownWaitMs?: number
  log?: (message: string) => void
}

type ActiveClaim = {
  task: ClaimedDelegation
  generation: number
  controller: AbortController
  lost: boolean
  settleLost: () => void
  lostPromise: Promise<void>
  release?: Promise<void>
  cleanupHeartbeat?: () => void
}

type Drain = { generation: number; promise: Promise<void> }

export class DelegationRunner {
  private readonly client: DelegationClient
  private readonly executor: DelegationExecutor
  private readonly claimedByLabel: string
  private readonly persistIdempotencyKey?: DelegationRunnerOptions["persistIdempotencyKey"]
  private readonly pollMs: number
  private readonly heartbeatMs: number
  private readonly shutdownWaitMs: number
  private readonly log: (message: string) => void

  private stopped = true
  private generation = 0
  private current: Drain | undefined
  private stopOperation: Drain | undefined
  private pollTimer: ReturnType<typeof setInterval> | undefined
  private active: ActiveClaim | undefined
  private readonly pendingNudged = new Set<string>()
  private readonly accessRequested = new Set<string>()

  constructor(opts: DelegationRunnerOptions) {
    this.client = opts.client
    this.executor = opts.executor
    this.claimedByLabel = opts.claimedByLabel
    this.persistIdempotencyKey = opts.persistIdempotencyKey
    this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS
    this.heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
    this.shutdownWaitMs = opts.shutdownWaitMs ?? SHUTDOWN_WAIT_MS
    this.log = opts.log ?? (() => {})
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.generation += 1
    const generation = this.generation
    this.pollTimer = setInterval(() => this.drain(generation), this.pollMs)
    this.drain(generation)
  }

  async stop(_reason = DELEGATION_STOP_REASON, options?: { strict?: boolean }): Promise<void> {
    if (!this.stopped) this.stopped = true
    const generation = this.generation
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = undefined

    const active = this.active?.generation === generation ? this.active : undefined
    active?.cleanupHeartbeat?.()
    active?.controller.abort()
    let pending = this.stopOperation?.generation === generation ? this.stopOperation.promise : undefined
    if (!pending) {
      const release = active && !active.lost ? this.releaseActive(active) : undefined
      pending = release ?? (this.current?.generation === generation ? this.current.promise : Promise.resolve())
      this.stopOperation = { generation, promise: pending }
    }

    if (this.current?.generation === generation) this.current = undefined
    if (this.active === active) this.active = undefined

    const timeoutError = new Error(`delegation runner stop timed out after ${this.shutdownWaitMs}ms`)
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(timeoutError), this.shutdownWaitMs)
    })
    try {
      if (options?.strict) await Promise.race([pending, timeout])
      else await Promise.race([pending.catch(() => undefined), timeout.catch(() => undefined)])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  notifyAvailable(nudge?: { delegationId?: string }): void {
    if (nudge?.delegationId) this.pendingNudged.add(nudge.delegationId)
    this.drain(this.generation)
  }

  private isCurrent(generation: number): boolean {
    return !this.stopped && this.generation === generation
  }

  private drain(generation: number): void {
    if (!this.isCurrent(generation) || this.current?.generation === generation) return
    const promise = this.runDrain(generation).finally(() => {
      if (this.current?.promise === promise) this.current = undefined
    })
    this.current = { generation, promise }
    void promise.catch((error) => {
      this.log(`delegation drain failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  private async runDrain(generation: number): Promise<void> {
    let executed = true
    while (executed && this.isCurrent(generation)) {
      executed = false
      const open = await this.client.listOpen()
      if (!this.isCurrent(generation)) return
      for (const summary of open) this.pendingNudged.delete(summary.id)
      for (const summary of open) {
        if (!this.isCurrent(generation)) return
        const claimed = await this.tryClaim(summary)
        if (!claimed) continue
        if (!this.isCurrent(generation)) {
          await this.releaseStoppedClaim(claimed, generation)
          return
        }
        await this.execute(claimed, generation)
        executed = true
        break
      }
      if (executed) continue
      for (const id of [...this.pendingNudged]) {
        if (!this.isCurrent(generation)) return
        const claimed = await this.tryClaimNudged(id)
        if (!claimed) continue
        if (!this.isCurrent(generation)) {
          await this.releaseStoppedClaim(claimed, generation)
          return
        }
        await this.execute(claimed, generation)
        executed = true
        break
      }
    }
  }

  private async tryClaim(summary: DelegationSummary): Promise<ClaimedDelegation | null> {
    const idempotencyKey = crypto.randomUUID()
    await this.persistIdempotencyKey?.(summary.id, idempotencyKey)
    try {
      return await this.client.claim(summary.id, { claimedByLabel: this.claimedByLabel, idempotencyKey })
    } catch (error) {
      if (error instanceof ThreaApiError && (error.status === 409 || error.status === 404)) return null
      throw error
    }
  }

  private async tryClaimNudged(id: string): Promise<ClaimedDelegation | null> {
    const idempotencyKey = crypto.randomUUID()
    await this.persistIdempotencyKey?.(id, idempotencyKey)
    try {
      const claimed = await this.client.claim(id, { claimedByLabel: this.claimedByLabel, idempotencyKey })
      this.pendingNudged.delete(id)
      return claimed
    } catch (error) {
      if (error instanceof ThreaApiError && error.status === 409) {
        this.pendingNudged.delete(id)
        return null
      }
      if (error instanceof ThreaApiError && error.status === 404) {
        await this.requestAccessOnce(id)
        this.pendingNudged.delete(id)
        return null
      }
      throw error
    }
  }

  private async requestAccessOnce(id: string): Promise<void> {
    if (this.accessRequested.has(id)) return
    try {
      await this.client.requestAccess(id, { requestedByLabel: this.claimedByLabel })
      this.accessRequested.add(id)
      this.log(`delegation ${id} not claimable (no access) — filed an access request`)
    } catch (error) {
      this.log(`delegation ${id} access request failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async releaseStoppedClaim(task: ClaimedDelegation, generation: number): Promise<void> {
    const active = this.createActiveClaim(task, generation)
    await this.releaseActive(active)
  }

  private createActiveClaim(task: ClaimedDelegation, generation: number): ActiveClaim {
    let settleLost!: () => void
    const lostPromise = new Promise<void>((resolve) => (settleLost = resolve))
    return { task, generation, controller: new AbortController(), lost: false, settleLost, lostPromise }
  }

  private releaseActive(active: ActiveClaim): Promise<void> {
    if (active.release) return active.release
    const release = this.client.release(active.task.id, active.task.claimToken).then(() => undefined)
    active.release = release
    void release.catch((error) => {
      this.log(`delegation ${active.task.id} release failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    return release
  }

  private async execute(task: ClaimedDelegation, generation: number): Promise<void> {
    const { id, claimToken } = task
    const active = this.createActiveClaim(task, generation)
    this.active = active
    let heartbeatBusy = false
    const cleanupHeartbeat = () => {
      if (!active.cleanupHeartbeat) return
      active.cleanupHeartbeat = undefined
      clearInterval(heartbeat)
    }
    const loseClaim = () => {
      if (active.lost) return
      active.lost = true
      cleanupHeartbeat()
      active.controller.abort()
      active.settleLost()
    }
    const handleLifecycleError = (kind: string, error: unknown) => {
      if (error instanceof ThreaApiError && error.status === 404) loseClaim()
      this.log(`delegation ${id} ${kind} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    const heartbeat = setInterval(async () => {
      if (heartbeatBusy || active.lost || active.controller.signal.aborted) return
      heartbeatBusy = true
      try {
        await this.client.heartbeat(id, claimToken)
      } catch (error) {
        handleLifecycleError("heartbeat", error)
      } finally {
        heartbeatBusy = false
      }
    }, this.heartbeatMs)
    active.cleanupHeartbeat = cleanupHeartbeat

    const ctx: DelegationExecutorContext = {
      signal: active.controller.signal,
      reportStatus: async (note: string) => {
        if (active.lost || active.controller.signal.aborted) return
        try {
          await this.client.reportStatus(id, claimToken, note.slice(0, STATUS_NOTE_MAX))
        } catch (error) {
          handleLifecycleError("status report", error)
        }
      },
    }

    const execution = Promise.resolve()
      .then(() => this.executor(task, ctx))
      .then(
        (result) => ({ kind: "result" as const, result }),
        (error: unknown) => ({ kind: "error" as const, error })
      )
    try {
      const outcome = await Promise.race([execution, active.lostPromise.then(() => ({ kind: "lost" as const }))])
      if (outcome.kind === "lost") return
      if (active.lost || active.controller.signal.aborted || !this.isCurrent(generation) || this.active !== active)
        return
      if (outcome.kind === "error") throw outcome.error
      await this.client.complete(id, claimToken, {
        resultMarkdown: outcome.result?.resultMarkdown,
        metadata: outcome.result?.metadata,
      })
      this.log(`delegation ${id} completed`)
    } catch (error) {
      if (active.lost || active.controller.signal.aborted || !this.isCurrent(generation) || this.active !== active)
        return
      const message = (error instanceof Error ? error.message : String(error)).slice(0, FAIL_MESSAGE_MAX)
      try {
        await this.client.fail(id, claimToken, message || "Delegation runner failed without a message")
      } catch (failError) {
        this.log(
          `delegation ${id} failed AND the fail report failed: ${failError instanceof Error ? failError.message : String(failError)}`
        )
      }
    } finally {
      cleanupHeartbeat()
      if (this.active === active) this.active = undefined
    }
  }
}
