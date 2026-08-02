import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { act, render } from "@testing-library/react"
import {
  NO_CAPTURE,
  getPerfArmingSources,
  getPerfCapture,
  isUploadPermitted,
  resetPerfArming,
  setPerfConsentArmed,
  setPerfDevArmed,
} from "./capture"
import { PerfCaptureProvider } from "./context"

const CAPTURE_STORAGE_KEY = "threa:perf:capture"

function windowHandle(): unknown {
  return (window as Window & { __threaPerfCapture?: unknown }).__threaPerfCapture
}

describe("PerfCaptureProvider arming lifecycle", () => {
  beforeEach(() => {
    resetPerfArming()
    window.localStorage.removeItem(CAPTURE_STORAGE_KEY)
  })

  afterEach(() => {
    resetPerfArming()
    window.localStorage.removeItem(CAPTURE_STORAGE_KEY)
  })

  it("measures under dev arming but never permits upload", () => {
    window.localStorage.setItem(CAPTURE_STORAGE_KEY, "1")
    render(<PerfCaptureProvider>{null}</PerfCaptureProvider>)

    expect(getPerfCapture()).not.toBe(NO_CAPTURE)
    expect(isUploadPermitted(getPerfArmingSources())).toBe(false)
  })

  it("clears the buffer and removes the window handle when every source disarms", () => {
    window.localStorage.setItem(CAPTURE_STORAGE_KEY, "1")
    render(<PerfCaptureProvider>{null}</PerfCaptureProvider>)
    const capture = getPerfCapture()
    capture.mark("liveQuery.rerun", 5)
    expect(windowHandle()).toBeDefined()

    act(() => setPerfDevArmed(false))

    expect(getPerfCapture()).toBe(NO_CAPTURE)
    expect(capture.snapshot()).toEqual([])
    expect(windowHandle()).toBeUndefined()
  })

  it("drops everything measured before consent when consent turns on", () => {
    window.localStorage.setItem(CAPTURE_STORAGE_KEY, "1")
    render(<PerfCaptureProvider>{null}</PerfCaptureProvider>)
    getPerfCapture().mark("liveQuery.rerun", 5)
    getPerfCapture().count("stream.eventApply")
    expect(getPerfCapture().snapshot()).toHaveLength(2)

    act(() => setPerfConsentArmed(true))

    expect(isUploadPermitted(getPerfArmingSources())).toBe(true)
    expect(getPerfCapture().snapshot()).toEqual([])
  })

  it("drops everything measured under consent when consent is withdrawn", () => {
    window.localStorage.setItem(CAPTURE_STORAGE_KEY, "1")
    render(<PerfCaptureProvider>{null}</PerfCaptureProvider>)
    act(() => setPerfConsentArmed(true))
    getPerfCapture().mark("liveQuery.rerun", 5)

    act(() => setPerfConsentArmed(false))

    expect(getPerfArmingSources()).toEqual({ dev: true, consent: false })
    expect(getPerfCapture().snapshot()).toEqual([])
  })
})
