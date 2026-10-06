import { describe, it, expect, vi, afterEach } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { useRerenderAt } from "./use-rerender-at"

const MAX_TIMEOUT_MS = 2_147_483_647

describe("useRerenderAt", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("re-renders at an instant beyond setTimeout's ceiling, not before", () => {
    vi.useFakeTimers()
    const instant = new Date(Date.now() + MAX_TIMEOUT_MS + 60_000).toISOString()
    let renders = 0
    renderHook(() => {
      renders++
      useRerenderAt(instant)
    })

    act(() => {
      vi.advanceTimersByTime(MAX_TIMEOUT_MS)
    })
    const rendersBeforeInstant = renders

    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect({ rendersBeforeInstant, renders }).toEqual({ rendersBeforeInstant: 2, renders: 3 })
  })
})
