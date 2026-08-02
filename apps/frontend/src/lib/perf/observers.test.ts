import { afterEach, describe, expect, it, vi } from "vitest"
import { NO_CAPTURE, PerfCapture } from "./capture"
import { startObservers } from "./observers"

type ObserverCallback = (list: { getEntries: () => { duration: number }[] }) => void

const constructed: FakeObserver[] = []

class FakeObserver {
  disconnected = false
  observedTypes: string[] = []

  constructor(public callback: ObserverCallback) {
    constructed.push(this)
  }

  observe(options: { type: string }) {
    this.observedTypes.push(options.type)
  }

  disconnect() {
    this.disconnected = true
  }
}

function installFakes() {
  constructed.length = 0
  vi.stubGlobal("PerformanceObserver", FakeObserver)

  const cancelled: number[] = []
  let frameCallback: FrameRequestCallback | null = null
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frameCallback = cb
    return 7
  })
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
    cancelled.push(handle)
  })

  return { cancelled, runFrame: (t: number) => frameCallback?.(t) }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("startObservers", () => {
  it("constructs no PerformanceObserver when unarmed", () => {
    installFakes()
    const dispose = startObservers(NO_CAPTURE)
    expect(constructed).toHaveLength(0)
    dispose()
  })

  it("records long tasks and event durations when armed", () => {
    installFakes()
    const capture = new PerfCapture()
    const dispose = startObservers(capture)

    expect(constructed.map((o) => o.observedTypes)).toEqual([["longtask"], ["event"]])
    constructed[0].callback({ getEntries: () => [{ duration: 123 }] })
    constructed[1].callback({ getEntries: () => [{ duration: 45 }] })

    expect(capture.snapshot().map((s) => [s.name, s.value])).toEqual([
      ["observer.longTask", 123],
      ["observer.eventDuration", 45],
    ])
    dispose()
  })

  it("records a frame gap only past the threshold", () => {
    const { runFrame } = installFakes()
    const capture = new PerfCapture()
    const dispose = startObservers(capture)

    runFrame(0)
    runFrame(10)
    runFrame(200)

    expect(capture.snapshot()).toEqual([{ name: "observer.frameGap", at: expect.any(Number), value: 190 }])
    dispose()
  })

  it("disposer disconnects every observer and cancels the rAF loop", () => {
    const { cancelled } = installFakes()
    const dispose = startObservers(new PerfCapture())

    dispose()

    expect(constructed.every((o) => o.disconnected)).toBe(true)
    expect(cancelled).toEqual([7])
  })
})
