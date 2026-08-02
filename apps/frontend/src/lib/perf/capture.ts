import { PERF_CAPTURE_MAX_SAMPLES, type PerfMarkName, type PerformanceSample } from "@threa/types"

const CAPTURE_STORAGE_KEY = "threa:perf:capture"
const PINNED_MAX = 48
const RING_CAPACITY = PERF_CAPTURE_MAX_SAMPLES - PINNED_MAX

export interface PerfCaptureLike {
  readonly startedAt: string
  mark(name: PerfMarkName, value?: number): void
  count(name: PerfMarkName): void
  time(name: PerfMarkName): () => void
  snapshot(): PerformanceSample[]
  clear(): void
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now()
}

/**
 * Fixed-size ring of samples. Oldest entries are overwritten rather than
 * dropped at the tail: a long session must keep measuring, and the recent
 * window is the one worth reading.
 */
export class PerfCapture implements PerfCaptureLike {
  private buffer: PerformanceSample[] = new Array(RING_CAPACITY)
  private pinned: PerformanceSample[] = []
  private next = 0
  private filled = false
  private startedAtValue = new Date().toISOString()

  get startedAt(): string {
    return this.startedAtValue
  }

  mark(name: PerfMarkName, value?: number): void {
    this.push(value === undefined ? { name, at: now() } : { name, at: now(), value })
  }

  count(name: PerfMarkName): void {
    this.push({ name, at: now(), count: 1 })
  }

  time(name: PerfMarkName): () => void {
    const startedAt = now()
    return () => {
      this.push({ name, at: startedAt, value: now() - startedAt })
    }
  }

  snapshot(): PerformanceSample[] {
    const ring = this.filled
      ? [...this.buffer.slice(this.next), ...this.buffer.slice(0, this.next)]
      : this.buffer.slice(0, this.next)
    return [...this.pinned, ...ring].sort((a, b) => a.at - b.at)
  }

  clear(): void {
    this.buffer = new Array(RING_CAPACITY)
    this.pinned = []
    this.next = 0
    this.filled = false
    this.startedAtValue = new Date().toISOString()
  }

  private push(sample: PerformanceSample): void {
    // Draft marks fire per keystroke; precise timestamps would upload
    // keystroke-dynamics-grade cadence, a content proxy the schema's
    // no-free-text rule cannot see. Durations/sizes keep full precision.
    if (sample.name.startsWith("draft.")) sample = { ...sample, at: Math.floor(sample.at / 1000) * 1000 }
    // Bootstrap marks fire once per session; the ring would evict them long
    // before an export, so they live outside it.
    if (sample.name.startsWith("bootstrap.")) {
      if (this.pinned.length < PINNED_MAX) this.pinned.push(sample)
      return
    }
    this.buffer[this.next] = sample
    this.next = (this.next + 1) % RING_CAPACITY
    if (this.next === 0) this.filled = true
  }
}

const NO_OP_STOP = (): void => {}

/**
 * The disarmed capture. Every instrumentation call site holds one of these
 * unless capture is armed, so the off path is a frozen method call and nothing
 * else — no allocation, no timestamp, no buffer.
 */
export const NO_CAPTURE: PerfCaptureLike = Object.freeze({
  startedAt: "",
  mark: (): void => {},
  count: (): void => {},
  time: (): (() => void) => NO_OP_STOP,
  snapshot: (): PerformanceSample[] => [],
  clear: (): void => {},
})

function armedFromSearchParams(): boolean | null {
  if (typeof window === "undefined") return null
  const value = new URLSearchParams(window.location.search).get("perfCapture")
  if (value === "1" || value === "true") return true
  if (value === "0" || value === "false") return false
  return null
}

export function isCaptureArmed(): boolean {
  if (typeof window === "undefined") return false

  // try/catch is load-bearing: reading window.localStorage itself throws a
  // SecurityError under blocked-storage policies, and this runs at module load.
  try {
    const paramFlag = armedFromSearchParams()
    if (paramFlag !== null) return paramFlag

    const stored = window.localStorage.getItem(CAPTURE_STORAGE_KEY)
    return stored === "1" || stored === "true"
  } catch {
    return false
  }
}

let moduleCapture: PerfCaptureLike = NO_CAPTURE

/**
 * Arming has exactly one production caller: the provider in `context.tsx`,
 * which decides once per mount. Non-React modules (sync engine,
 * draft staging) read `getPerfCapture()` instead of taking the capture through
 * a constructor, so instrumenting a hot path never changes its signature.
 */
export function armPerfCapture(capture: PerfCaptureLike): void {
  moduleCapture = capture
}

export function getPerfCapture(): PerfCaptureLike {
  return moduleCapture
}
