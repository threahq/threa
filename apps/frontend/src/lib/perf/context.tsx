import { createContext, useContext, useEffect, useRef, type ReactNode } from "react"
import { NO_CAPTURE, PerfCapture, armPerfCapture, isCaptureArmed, type PerfCaptureLike } from "./capture"
import { installCaptureWindowHandle } from "./export"
import { startObservers } from "./observers"

const PerfCaptureContext = createContext<PerfCaptureLike>(NO_CAPTURE)

/**
 * Decides armed-or-not once per mount and never again, so the context value is
 * referentially stable and this provider adds no renders to the tree it wraps.
 */
export function PerfCaptureProvider({ children }: { children: ReactNode }) {
  const captureRef = useRef<PerfCaptureLike | null>(null)
  if (captureRef.current === null) {
    captureRef.current = isCaptureArmed() ? new PerfCapture() : NO_CAPTURE
  }
  const capture = captureRef.current

  useEffect(() => {
    if (capture === NO_CAPTURE) return
    armPerfCapture(capture)
    installCaptureWindowHandle(capture)
    const dispose = startObservers(capture)
    return () => {
      dispose()
      armPerfCapture(NO_CAPTURE)
      if (typeof window !== "undefined") delete (window as Window & { __threaPerfCapture?: unknown }).__threaPerfCapture
    }
  }, [capture])

  return <PerfCaptureContext.Provider value={capture}>{children}</PerfCaptureContext.Provider>
}

export function usePerfCapture(): PerfCaptureLike {
  return useContext(PerfCaptureContext)
}
