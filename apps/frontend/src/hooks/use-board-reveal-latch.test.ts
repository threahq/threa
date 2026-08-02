import { describe, expect, it } from "vitest"
import { renderHook } from "@testing-library/react"
import { useBoardRevealLatch } from "./use-board-reveal-latch"

describe("useBoardRevealLatch", () => {
  it("holds the first paint until ready, then latches so a later cold rail can't un-paint", () => {
    const { result, rerender } = renderHook(({ ready, posts, ws }) => useBoardRevealLatch(ready, posts, ws), {
      initialProps: { ready: false, posts: true, ws: "ws_1" },
    })
    // Not yet ready → still gating the first paint.
    expect(result.current).toBe(false)
    // Rails + graph warm → revealed.
    rerender({ ready: true, posts: true, ws: "ws_1" })
    expect(result.current).toBe(true)
    // A newly added conversation's cold rail flips readiness false — the feed must
    // stay revealed (this is the whole point: no blank flash on add).
    rerender({ ready: false, posts: true, ws: "ws_1" })
    expect(result.current).toBe(true)
  })

  it("does not latch on a ready state observed with no posts, and re-gates when posts arrive cold", () => {
    // The cold-load shape: no posts yet, so every readiness input is an `every()`
    // over an empty set and reads true. Latching here would defeat the hold before
    // the feed existed and the first cards would paint projection-first.
    const { result, rerender } = renderHook(({ ready, posts, ws }) => useBoardRevealLatch(ready, posts, ws), {
      initialProps: { ready: true, posts: false, ws: "ws_1" },
    })
    // Vacuously ready with an empty feed — nothing to hold, nothing to latch.
    expect(result.current).toBe(true)

    // Posts commit and their rails are cold: the gate must hold again.
    rerender({ ready: false, posts: true, ws: "ws_1" })
    expect(result.current).toBe(false)

    // Genuinely ready WITH content → reveal, and now the latch counts.
    rerender({ ready: true, posts: true, ws: "ws_1" })
    expect(result.current).toBe(true)
    rerender({ ready: false, posts: true, ws: "ws_1" })
    expect(result.current).toBe(true)
  })

  it("re-gates on a workspace switch", () => {
    const { result, rerender } = renderHook(({ ready, posts, ws }) => useBoardRevealLatch(ready, posts, ws), {
      initialProps: { ready: true, posts: true, ws: "ws_1" },
    })
    expect(result.current).toBe(true)
    // A different workspace is a genuinely new board — gate its first paint afresh
    // even though the previous workspace had revealed.
    rerender({ ready: false, posts: true, ws: "ws_2" })
    expect(result.current).toBe(false)
  })
})
