import { PERF_CAPTURE_MAX_SAMPLES } from "@threa/types"
import { describe, expect, it } from "vitest"
import { PerfCapture } from "./capture"

describe("PerfCapture ring buffer", () => {
  it("evicts the oldest samples past the cap", () => {
    const capture = new PerfCapture()
    for (let i = 0; i < 2100; i++) capture.mark("catchup.entryApply", i)

    const samples = capture.snapshot()
    expect(samples).toHaveLength(2000)
    expect(samples[0]?.value).toBe(100)
    expect(samples[samples.length - 1]?.value).toBe(2099)
  })

  it("keeps one-shot bootstrap marks that the ring would have evicted", () => {
    const capture = new PerfCapture()
    capture.mark("bootstrap.rowsWritten", 7)
    for (let i = 0; i < 5000; i++) capture.mark("catchup.entryApply", i)

    const samples = capture.snapshot()
    expect(samples.find((s) => s.name === "bootstrap.rowsWritten")?.value).toBe(7)
    expect(samples.length).toBeLessThanOrEqual(PERF_CAPTURE_MAX_SAMPLES)
  })

  it("never exceeds the schema sample cap", () => {
    const capture = new PerfCapture()
    for (let i = 0; i < 200; i++) capture.mark("bootstrap.tx", i)
    for (let i = 0; i < 6000; i++) capture.mark("catchup.entryApply", i)

    expect(capture.snapshot().length).toBeLessThanOrEqual(PERF_CAPTURE_MAX_SAMPLES)
  })

  it("returns a copy, not the live buffer", () => {
    const capture = new PerfCapture()
    capture.mark("stream.eventApply", 1)

    const first = capture.snapshot()
    capture.mark("stream.eventApply", 2)

    expect(first).toHaveLength(1)
    expect(capture.snapshot()).toHaveLength(2)
    expect(capture.snapshot()).not.toBe(first)
  })

  it("clear empties both the ring and the pinned bootstrap samples", () => {
    const capture = new PerfCapture()
    capture.count("liveQuery.rerun")
    capture.mark("bootstrap.tx", 1)
    capture.clear()
    expect(capture.snapshot()).toEqual([])
  })

  it("re-stamps startedAt on clear", async () => {
    const capture = new PerfCapture()
    const first = capture.startedAt
    await new Promise((resolve) => setTimeout(resolve, 2))
    capture.clear()
    expect(capture.startedAt).not.toBe(first)
  })

  it("time() records the elapsed duration under the mark name", () => {
    const capture = new PerfCapture()
    const stop = capture.time("bootstrap.fetch")
    stop()

    const [sample] = capture.snapshot()
    expect(sample?.name).toBe("bootstrap.fetch")
    expect(typeof sample?.value).toBe("number")
  })
})

describe("draft mark timestamp quantization", () => {
  it("coarsens draft.* timestamps to whole seconds and leaves values precise", () => {
    const capture = new PerfCapture()
    capture.mark("draft.stagedChars", 1234)
    capture.mark("bootstrap.tx", 1)

    const samples = capture.snapshot()
    const draft = samples.find((s) => s.name === "draft.stagedChars")
    const other = samples.find((s) => s.name === "bootstrap.tx")
    expect(draft && draft.at % 1000).toBe(0)
    expect(draft?.value).toBe(1234)
    expect(other && other.at % 1000).not.toBe(0)
  })
})
