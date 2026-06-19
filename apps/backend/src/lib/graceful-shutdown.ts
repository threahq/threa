interface ShutdownTimers {
  setTimeout: (callback: () => void, ms: number) => { unref?: () => void }
  clearTimeout: (handle: unknown) => void
}

export interface ShutdownWatchdogOptions {
  /** The graceful-shutdown routine to run. Must not reject — wrap logging inside it. */
  shutdown: () => Promise<void>
  /** Hard deadline; if `shutdown` overruns it, `onTimeout` fires instead of `onComplete`. */
  timeoutMs: number
  /** Fired once when `shutdown` settles within the deadline. */
  onComplete: () => void
  /** Fired once when the deadline elapses before `shutdown` settles. */
  onTimeout: () => void
  /** Injectable timers for tests; defaults to the globals. */
  timers?: ShutdownTimers
}

/**
 * Runs a graceful-shutdown routine under a hard deadline, firing exactly one of
 * `onComplete` / `onTimeout`.
 *
 * Without this, a wedged shutdown — `pool.end()` blocking on an unreachable
 * Postgres is the live example — leaves the process half-dead: it never exits,
 * emits no logs, and the supervisor (Railway) never restarts it, so a transient
 * DB outage becomes a prolonged one. The watchdog forces termination past the
 * deadline so the supervisor can restart us, which auto-recovers the moment the
 * DB is reachable again.
 */
export async function runWithShutdownWatchdog(options: ShutdownWatchdogOptions): Promise<void> {
  const { shutdown, timeoutMs, onComplete, onTimeout } = options
  const timers: ShutdownTimers = options.timers ?? {
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  }

  let settled = false
  const handle = timers.setTimeout(() => {
    if (settled) return
    settled = true
    onTimeout()
  }, timeoutMs)
  // Don't let the watchdog timer itself hold the event loop open.
  handle.unref?.()

  try {
    await shutdown()
  } finally {
    timers.clearTimeout(handle)
    if (!settled) {
      settled = true
      onComplete()
    }
  }
}
