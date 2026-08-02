import { NO_CAPTURE, type PerfCaptureLike } from "./capture"

// 25ms is ~1.5 missed frames at 60Hz: real misses record, per-frame jitter does
// not. The distribution is censored below this floor — the reproduction matrix
// states its frame-gap targets in these terms.
const FRAME_GAP_THRESHOLD_MS = 25

/**
 * Only durations are read off browser performance entries. Names, target
 * selectors, and URLs stay in the browser — a capture carries numbers.
 */
export function startObservers(capture: PerfCaptureLike): () => void {
  if (capture === NO_CAPTURE) return () => {}
  if (typeof window === "undefined") return () => {}

  const observers: PerformanceObserver[] = []

  if (typeof PerformanceObserver === "function") {
    const observe = (type: string, mark: "observer.longTask" | "observer.eventDuration") => {
      try {
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) capture.mark(mark, entry.duration)
        })
        // durationThreshold applies to "event" only (16 is the API minimum;
        // the default 104 would sit above the INP target this exists to verify).
        // NOT buffered: the browser's own entry buffer predates arming, and a
        // consent-armed capture must never import pre-consent activity.
        observer.observe({ type, durationThreshold: 16 } as PerformanceObserverInit)
        observers.push(observer)
      } catch {
        // Entry type unsupported in this browser — the other observers still run.
      }
    }
    observe("longtask", "observer.longTask")
    observe("event", "observer.eventDuration")
  }

  let frameHandle: number | null = null
  let lastFrameAt: number | null = null

  // A hidden tab suspends/throttles rAF; those pauses are not jank. Reset the
  // baseline on visibility changes so the first frame back records nothing.
  const onVisibility = () => {
    lastFrameAt = null
  }

  if (typeof requestAnimationFrame === "function") {
    const tick = (timestamp: number) => {
      if (typeof document !== "undefined" && document.hidden) {
        lastFrameAt = null
      } else {
        if (lastFrameAt !== null) {
          const gap = timestamp - lastFrameAt
          if (gap >= FRAME_GAP_THRESHOLD_MS) capture.mark("observer.frameGap", gap)
        }
        lastFrameAt = timestamp
      }
      frameHandle = requestAnimationFrame(tick)
    }
    frameHandle = requestAnimationFrame(tick)
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility)
  }

  return () => {
    for (const observer of observers) observer.disconnect()
    observers.length = 0
    if (frameHandle !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frameHandle)
    frameHandle = null
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility)
  }
}
