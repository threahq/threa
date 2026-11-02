import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { markInitialRevealComplete, waitForInitialReveal, resetRevealGate } from "./reveal-gate"

describe("reveal-gate", () => {
  beforeEach(() => {
    resetRevealGate()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("resolves the wait once the reveal is marked complete", async () => {
    let resolved = false
    const wait = waitForInitialReveal("ws_1").then(() => {
      resolved = true
    })

    await Promise.resolve()
    expect(resolved).toBe(false)

    markInitialRevealComplete("ws_1")
    await wait
    expect(resolved).toBe(true)
  })

  it("resolves immediately when the reveal already happened", async () => {
    markInitialRevealComplete("ws_1")

    let resolved = false
    await waitForInitialReveal("ws_1").then(() => {
      resolved = true
    })
    expect(resolved).toBe(true)
  })

  it("falls back to the timeout so freshness is never indefinitely delayed", async () => {
    vi.useFakeTimers()

    let resolved = false
    const wait = waitForInitialReveal("ws_1", 2000).then(() => {
      resolved = true
    })

    await vi.advanceTimersByTimeAsync(1999)
    expect(resolved).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await wait
    expect(resolved).toBe(true)
  })

  it("keeps reveal state independent per workspace", async () => {
    markInitialRevealComplete("ws_a")

    let aResolved = false
    let bResolved = false
    void waitForInitialReveal("ws_a").then(() => {
      aResolved = true
    })
    void waitForInitialReveal("ws_b").then(() => {
      bResolved = true
    })

    await Promise.resolve()
    await Promise.resolve()
    expect(aResolved).toBe(true)
    expect(bResolved).toBe(false)
  })
})
