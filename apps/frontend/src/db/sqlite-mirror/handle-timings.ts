export interface HandleTimings {
  handleCount: number
  handleMinMs: number
  handleMaxMs: number
  /** From the first acquisition starting to the last settling. */
  handleSpanMs: number
}

interface SyncHandleOpener {
  createSyncAccessHandle(this: unknown, ...args: never[]): Promise<unknown>
}

/**
 * Times every sync access handle acquired while `install` runs. The pool's
 * install offers no hook of its own, so the opener is wrapped for its duration.
 */
export async function timeHandleAcquisition<T>(
  opener: SyncHandleOpener,
  install: () => Promise<T>
): Promise<{ result: T; handles: HandleTimings }> {
  const acquire = opener.createSyncAccessHandle
  const spans: Array<{ startedAt: number; endedAt: number }> = []
  opener.createSyncAccessHandle = function (...args) {
    const startedAt = performance.now()
    const settle = () => spans.push({ startedAt, endedAt: performance.now() })
    const handle = acquire.apply(this, args)
    handle.then(settle, settle)
    return handle
  }
  try {
    const result = await install()
    return { result, handles: summarize(spans) }
  } finally {
    opener.createSyncAccessHandle = acquire
  }
}

function summarize(spans: Array<{ startedAt: number; endedAt: number }>): HandleTimings {
  // A pool already installed in this worker resolves without acquiring any.
  if (spans.length === 0) return { handleCount: 0, handleMinMs: 0, handleMaxMs: 0, handleSpanMs: 0 }
  const durations = spans.map((span) => span.endedAt - span.startedAt)
  const firstStart = Math.min(...spans.map((span) => span.startedAt))
  const lastEnd = Math.max(...spans.map((span) => span.endedAt))
  return {
    handleCount: spans.length,
    handleMinMs: Math.round(Math.min(...durations)),
    handleMaxMs: Math.round(Math.max(...durations)),
    handleSpanMs: Math.round(lastEnd - firstStart),
  }
}
