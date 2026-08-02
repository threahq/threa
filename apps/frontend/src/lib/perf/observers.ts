import { NO_CAPTURE, type PerfCaptureLike } from "./capture"

const FRAME_GAP_THRESHOLD_MS = 50

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
        observer.observe({ type, buffered: true })
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

  if (typeof requestAnimationFrame === "function") {
    const tick = (timestamp: number) => {
      if (lastFrameAt !== null) {
        const gap = timestamp - lastFrameAt
        if (gap >= FRAME_GAP_THRESHOLD_MS) capture.mark("observer.frameGap", gap)
      }
      lastFrameAt = timestamp
      frameHandle = requestAnimationFrame(tick)
    }
    frameHandle = requestAnimationFrame(tick)
  }

  return () => {
    for (const observer of observers) observer.disconnect()
    observers.length = 0
    if (frameHandle !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frameHandle)
    frameHandle = null
  }
}
