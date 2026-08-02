import { renderHook } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { stageDraftContent } from "@/lib/drafts/draft-staging"
import { NO_CAPTURE, getPerfCapture } from "./capture"
import { PerfCaptureProvider, usePerfCapture } from "./context"
import { startObservers } from "./observers"

function wrapper({ children }: { children: ReactNode }) {
  return createElement(PerfCaptureProvider, null, children)
}

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe("perf capture when unarmed", () => {
  it("usePerfCapture returns the NO_CAPTURE singleton", () => {
    const { result } = renderHook(() => usePerfCapture(), { wrapper })
    expect(result.current).toBe(NO_CAPTURE)
    expect(getPerfCapture()).toBe(NO_CAPTURE)
  })

  it("records nothing when every instrumented helper is driven", () => {
    const capture = getPerfCapture()
    expect(capture).toBe(NO_CAPTURE)
    capture.mark("bootstrap.tx", 1)
    capture.count("stream.idbTransaction")
    capture.time("catchup.entryApply")()
    expect(capture.snapshot()).toEqual([])

    startObservers(capture)()
    stageDraftContent("ws_1", "scope_1", {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
    })

    expect(capture.snapshot()).toEqual([])
  })
})
