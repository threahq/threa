import { type PerfDeviceClass, type PerformanceCapture, performanceCaptureSchema } from "@threa/types"
import { ulid } from "ulid"
import { currentAppVersion } from "@/lib/app-build"
import { type PerfCaptureLike } from "./capture"

/**
 * Coarse buckets from core count and memory only. Neither value is reported
 * verbatim: a raw `(cores, memory)` pair is a fingerprint, a bucket is not.
 */
export function deviceClass(): PerfDeviceClass {
  const nav = typeof navigator === "undefined" ? undefined : (navigator as Navigator & { deviceMemory?: number })
  const cores = nav?.hardwareConcurrency ?? 0
  const memory = nav?.deviceMemory ?? 0
  if (cores >= 8 && memory >= 8) return "high"
  if (cores >= 4 || memory >= 4) return "mid"
  return "low"
}

export function exportCapture(capture: PerfCaptureLike): PerformanceCapture {
  return performanceCaptureSchema.parse({
    captureId: `cap_${ulid()}`,
    appVersion: currentAppVersion() ?? "unknown",
    deviceClass: deviceClass(),
    startedAt: capture.startedAt,
    samples: capture.snapshot(),
  })
}

interface PerfCaptureWindowHandle {
  export: () => PerformanceCapture
  clear: () => void
}

export function installCaptureWindowHandle(capture: PerfCaptureLike): void {
  if (typeof window === "undefined") return
  ;(window as Window & { __threaPerfCapture?: PerfCaptureWindowHandle }).__threaPerfCapture = {
    export: () => exportCapture(capture),
    clear: () => capture.clear(),
  }
}
