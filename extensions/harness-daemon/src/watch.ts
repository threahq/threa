const DEFAULT_WATCH_INTERVAL_MS = 60_000
const MIN_WATCH_INTERVAL_MS = 10_000

export interface SupervisorTarget {
  baseUrl: string
  workspaceId: string
  apiKey: string
}

export function uniqueSupervisorTargets(targets: Array<SupervisorTarget | undefined>): SupervisorTarget[] {
  const unique = new Map<string, SupervisorTarget>()
  for (const target of targets) {
    if (!target) continue
    unique.set(`${target.baseUrl}\0${target.workspaceId}\0${target.apiKey}`, target)
  }
  return [...unique.values()]
}

export function watchIntervalMs(value = process.env.THREA_HARNESSD_WATCH_INTERVAL_MS): number {
  if (value === undefined || value.trim() === "") return DEFAULT_WATCH_INTERVAL_MS
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < MIN_WATCH_INTERVAL_MS) {
    throw new Error(`THREA_HARNESSD_WATCH_INTERVAL_MS must be at least ${MIN_WATCH_INTERVAL_MS}`)
  }
  return Math.floor(parsed)
}

const UNAVAILABLE_BACKOFF_CAP_MS = 15 * 60_000
const PROBE_VERDICT_BACKOFF_CAP_MS = 6 * 60 * 60_000

function backoffMs(intervalMs: number, failures: number, capMs: number, random: () => number): number {
  const base = Math.min(intervalMs * 2 ** Math.max(1, failures), capMs)
  return Math.min(base + Math.floor(base * 0.1 * random()), capMs)
}

export function unavailableBackoffMs(intervalMs: number, failures: number, random = Math.random): number {
  return backoffMs(intervalMs, failures, UNAVAILABLE_BACKOFF_CAP_MS, random)
}

/**
 * A verdict (403/404, or archived) is a settled answer: a revoked grant, a deleted
 * stream, a session that ended. All of those outlive a pass, so the cap is hours
 * rather than minutes. Backoff and not pruning: a re-granted or unarchived stream
 * still heals itself, and an unarchive arrives as a restore event that skips the
 * backoff outright.
 */
export function probeVerdictBackoffMs(intervalMs: number, failures: number, random = Math.random): number {
  return backoffMs(intervalMs, failures, PROBE_VERDICT_BACKOFF_CAP_MS, random)
}

export async function runWatchLoop(params: {
  runPass: () => Promise<number | void>
  sleep: (ms: number) => Promise<void>
  intervalMs: number
  onError: (error: unknown) => void
  maxPasses?: number
}): Promise<void> {
  let passes = 0
  while (params.maxPasses === undefined || passes < params.maxPasses) {
    let delayMs = params.intervalMs
    try {
      delayMs = (await params.runPass()) ?? params.intervalMs
    } catch (error) {
      params.onError(error)
    }
    passes += 1
    if (params.maxPasses !== undefined && passes >= params.maxPasses) return
    await params.sleep(delayMs)
  }
}
