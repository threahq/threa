import { afterEach, describe, expect, test, vi } from "vitest"
import {
  flushPreviewVisibilityForTest,
  reportPreviewHidden,
  reportPreviewVisible,
  resetPreviewVisibility,
  setPreviewVisibilityEmitter,
} from "./preview-visibility"

afterEach(() => {
  resetPreviewVisibility()
})

describe("preview visibility batcher", () => {
  test("a flush emits one frame per workspace with the currently visible ids", () => {
    const emitter = vi.fn()
    setPreviewVisibilityEmitter(emitter)

    reportPreviewVisible("ws_a", "lp_1")
    reportPreviewVisible("ws_a", "lp_2")
    reportPreviewVisible("ws_b", "lp_3")
    flushPreviewVisibilityForTest()

    expect(emitter).toHaveBeenCalledTimes(2)
    expect(emitter).toHaveBeenCalledWith("ws_a", ["lp_1", "lp_2"])
    expect(emitter).toHaveBeenCalledWith("ws_b", ["lp_3"])
  })

  test("a hidden card leaves the next flush; re-reporting the same id does not duplicate", () => {
    const emitter = vi.fn()
    setPreviewVisibilityEmitter(emitter)

    reportPreviewVisible("ws_a", "lp_1")
    reportPreviewVisible("ws_a", "lp_1")
    reportPreviewVisible("ws_a", "lp_2")
    reportPreviewHidden("ws_a", "lp_1")
    flushPreviewVisibilityForTest()

    expect(emitter).toHaveBeenCalledTimes(1)
    expect(emitter).toHaveBeenCalledWith("ws_a", ["lp_2"])
  })

  test("nothing is emitted while every card is hidden or no emitter is wired", () => {
    const emitter = vi.fn()

    // No emitter yet: reports accumulate silently.
    reportPreviewVisible("ws_a", "lp_1")
    flushPreviewVisibilityForTest()
    expect(emitter).not.toHaveBeenCalled()

    // Emitter wired but the only card left: no frame.
    setPreviewVisibilityEmitter(emitter)
    reportPreviewHidden("ws_a", "lp_1")
    flushPreviewVisibilityForTest()
    expect(emitter).not.toHaveBeenCalled()
  })

  test("accumulated reports survive an emitter swap (reconnect)", () => {
    reportPreviewVisible("ws_a", "lp_1")

    const emitter = vi.fn()
    setPreviewVisibilityEmitter(emitter)
    flushPreviewVisibilityForTest()

    expect(emitter).toHaveBeenCalledWith("ws_a", ["lp_1"])
  })
})
