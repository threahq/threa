import { describe, expect, it } from "vitest"
import { renderHook } from "@testing-library/react"
import { useBoardRevealLatch } from "./use-board-reveal-latch"

describe("useBoardRevealLatch", () => {
  it("holds the first paint until ready, then latches so a later cold rail can't un-paint", () => {
    const { result, rerender } = renderHook(({ ready, ws }) => useBoardRevealLatch(ready, ws), {
      initialProps: { ready: false, ws: "ws_1" },
    })
    // Not yet ready → still gating the first paint.
    expect(result.current).toBe(false)
    // Rails + graph warm → revealed.
    rerender({ ready: true, ws: "ws_1" })
    expect(result.current).toBe(true)
    // A newly added conversation's cold rail flips readiness false — the feed must
    // stay revealed (this is the whole point: no blank flash on add).
    rerender({ ready: false, ws: "ws_1" })
    expect(result.current).toBe(true)
  })

  it("re-gates on a workspace switch", () => {
    const { result, rerender } = renderHook(({ ready, ws }) => useBoardRevealLatch(ready, ws), {
      initialProps: { ready: true, ws: "ws_1" },
    })
    expect(result.current).toBe(true)
    // A different workspace is a genuinely new board — gate its first paint afresh
    // even though the previous workspace had revealed.
    rerender({ ready: false, ws: "ws_2" })
    expect(result.current).toBe(false)
  })
})
