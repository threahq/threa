import { createContext, useContext, useEffect, useRef, useSyncExternalStore, type ReactNode } from "react"
import {
  NO_CAPTURE,
  PerfCapture,
  armPerfCapture,
  getPerfArmingSources,
  isCaptureArmed,
  setPerfDevArmed,
  shouldArmCapture,
  subscribePerfArming,
  type PerfCaptureLike,
} from "./capture"
import { installCaptureWindowHandle } from "./export"
import { startObservers } from "./observers"

const PerfCaptureContext = createContext<PerfCaptureLike>(NO_CAPTURE)

/**
 * Follows the arming sources rather than deciding once per mount: consent is a
 * user preference that can flip while the app is open, and a toggle that only
 * takes effect after a reload is not a working consent control. The store only
 * notifies on an actual arm/disarm, so the disarmed case still renders once.
 * Disarming disposes the observers and clears the buffer, so nothing measured
 * under the previous state survives into the next one.
 */
export function PerfCaptureProvider({ children }: { children: ReactNode }) {
  const sources = useSyncExternalStore(subscribePerfArming, getPerfArmingSources, getPerfArmingSources)

  useEffect(() => {
    setPerfDevArmed(isCaptureArmed())
  }, [])

  const captureRef = useRef<PerfCapture | null>(null)
  // The consent bit is a lifecycle boundary, not just an arming source: under
  // dev arming the capture keeps running across the toggle, so without dropping
  // the instance here samples measured before consent would be uploadable after
  // it — and samples measured under consent would outlive its withdrawal.
  const consentRef = useRef(sources.consent)
  if (consentRef.current !== sources.consent) {
    consentRef.current = sources.consent
    captureRef.current = null
  }
  const armed = shouldArmCapture(sources)
  if (armed && captureRef.current === null) captureRef.current = new PerfCapture()
  const capture: PerfCaptureLike = armed && captureRef.current ? captureRef.current : NO_CAPTURE

  useEffect(() => {
    if (capture === NO_CAPTURE) return
    armPerfCapture(capture)
    installCaptureWindowHandle(capture)
    const dispose = startObservers(capture)
    return () => {
      dispose()
      armPerfCapture(NO_CAPTURE)
      capture.clear()
      if (captureRef.current === capture) captureRef.current = null
      if (typeof window !== "undefined") delete (window as Window & { __threaPerfCapture?: unknown }).__threaPerfCapture
    }
  }, [capture])

  return <PerfCaptureContext.Provider value={capture}>{children}</PerfCaptureContext.Provider>
}

export function usePerfCapture(): PerfCaptureLike {
  return useContext(PerfCaptureContext)
}
