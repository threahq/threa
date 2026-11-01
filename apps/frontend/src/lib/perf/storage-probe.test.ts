import { afterEach, describe, expect, it, vi } from "vitest"
import { PerfCapture } from "./capture"
import { startStorageProbe } from "./storage-probe"

function stubProbeFile() {
  const handle = {
    getFile: async () => ({ size: 5, text: async () => "probe" }),
    createWritable: async () => ({ write: async () => {}, close: async () => {} }),
  }
  vi.stubGlobal("navigator", {
    ...navigator,
    storage: { getDirectory: async () => ({ getFileHandle: async () => handle }) },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("startStorageProbe", () => {
  it("records file reads that kept finishing while an IndexedDB read stalled", async () => {
    stubProbeFile()
    const original = IDBObjectStore.prototype.get
    let stalled = false
    vi.spyOn(IDBObjectStore.prototype, "get").mockImplementation(function (this: IDBObjectStore, key) {
      if (stalled) return original.call(this, key)
      stalled = true
      const request = {} as IDBRequest
      setTimeout(() => request.onsuccess?.(new Event("success")), 1300)
      return request
    })
    const capture = new PerfCapture()
    const stop = startStorageProbe(capture)

    await vi.waitFor(
      () => expect(capture.snapshot().some((sample) => sample.name === "probe.fileReadsDuringIdbStall")).toBe(true),
      { timeout: 4000 }
    )
    stop()

    const byName = new Map(capture.snapshot().map((sample) => [sample.name, sample.value]))
    expect(byName.get("probe.idbRead")).toBeGreaterThanOrEqual(1300)
    expect(byName.get("probe.fileReadsDuringIdbStall")).toBeGreaterThanOrEqual(1)
    expect(byName.get("probe.slowestFileReadDuringIdbStall")).toBeLessThan(30)
    expect(byName.has("probe.fileRead")).toBe(false)
  })

  it("does nothing without OPFS", () => {
    vi.stubGlobal("navigator", { ...navigator, storage: undefined })
    const capture = new PerfCapture()
    startStorageProbe(capture)()
    expect(capture.snapshot()).toEqual([])
  })
})
