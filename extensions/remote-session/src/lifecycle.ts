function describeError(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message
  return String(value)
}

/** The slice of `process` the lifecycle wiring touches, narrowed so it can be unit-tested with a fake. */
export interface LifecycleProcess {
  on(event: string, listener: (arg?: unknown) => void): unknown
  stdin: { on(event: string, listener: (arg?: unknown) => void): unknown }
  stderr: { write(chunk: string): unknown }
  exit(code: number): never
}

export interface LifecycleOptions {
  /** Prefix for shutdown log lines, e.g. "[threa-channel]". */
  logPrefix?: string
  /** Bound on teardown so a hung Threa request can't hold the process past its host's kill grace window. */
  exitGuardMs?: number
}

/**
 * Route every way the process can die through one graceful teardown, so the
 * session marks presence offline + fails its in-flight claim instead of just
 * vanishing. A host runtime typically never respawns a dead stdio child
 * mid-session, so a silent drop strands the scratchpad as "busy" with nobody to
 * answer until a human restarts. The paths covered:
 *  - SIGINT/SIGTERM — the host's normal stop, and a 2nd Ctrl-C.
 *  - SIGHUP — terminal/SSH/tmux disconnect (previously an unhandled hard kill).
 *  - stdin end/close — the parent's write end closed: the host exited, was
 *    killed, or was swapped out by an auto-update. The session we serve is gone,
 *    so exit rather than linger as an orphan that keeps renewing the claim.
 *  - uncaughtException/unhandledRejection — a steady-state throw would otherwise
 *    vanish the process with no log and no cleanup; log it and exit non-zero.
 */
export function wireLifecycle(
  server: { shutdown(): Promise<void> },
  host: LifecycleProcess,
  options: LifecycleOptions = {}
): void {
  const logPrefix = options.logPrefix ?? "[threa-remote]"
  const exitGuardMs = options.exitGuardMs ?? 4000
  let shuttingDown = false
  const shutdownAndExit = async (code: number, reason: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    host.stderr.write(`${logPrefix} shutting down (${reason})\n`)
    // Bound teardown so a hung Threa request can't hold us past the host's
    // SIGTERM→SIGKILL grace window — exit even if presence/fail never lands.
    const guard = setTimeout(() => host.exit(code), exitGuardMs)
    if (guard && typeof guard === "object" && "unref" in guard) (guard as { unref(): void }).unref()
    await server.shutdown().catch(() => undefined)
    clearTimeout(guard)
    host.exit(code)
  }

  host.on("SIGINT", () => void shutdownAndExit(0, "SIGINT"))
  host.on("SIGTERM", () => void shutdownAndExit(0, "SIGTERM"))
  host.on("SIGHUP", () => void shutdownAndExit(0, "SIGHUP"))
  host.stdin.on("end", () => void shutdownAndExit(0, "stdin closed by parent"))
  host.stdin.on("close", () => void shutdownAndExit(0, "stdin closed by parent"))
  host.on("uncaughtException", (error) => {
    host.stderr.write(`${logPrefix} uncaughtException: ${describeError(error)}\n`)
    void shutdownAndExit(1, "uncaughtException")
  })
  host.on("unhandledRejection", (reason) => {
    host.stderr.write(`${logPrefix} unhandledRejection: ${describeError(reason)}\n`)
    void shutdownAndExit(1, "unhandledRejection")
  })
}
