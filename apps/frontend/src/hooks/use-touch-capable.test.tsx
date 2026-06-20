import { afterEach, describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"

function stub(anyCoarse: boolean, maxTouchPoints: number) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("any-pointer: coarse") ? anyCoarse : false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }))
  Object.defineProperty(navigator, "maxTouchPoints", { value: maxTouchPoints, configurable: true })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe("useTouchCapable", () => {
  it("is true when a coarse pointer is available even if it is not primary (hybrid laptop)", async () => {
    stub(true, 0)
    const { useTouchCapable } = await import("./use-touch-capable")
    const { result } = renderHook(() => useTouchCapable())
    expect(result.current).toBe(true)
  })

  it("falls back to maxTouchPoints when the media query is unsupported", async () => {
    stub(false, 5)
    const { useTouchCapable } = await import("./use-touch-capable")
    const { result } = renderHook(() => useTouchCapable())
    expect(result.current).toBe(true)
  })

  it("is false on a pure mouse device", async () => {
    stub(false, 0)
    const { useTouchCapable } = await import("./use-touch-capable")
    const { result } = renderHook(() => useTouchCapable())
    expect(result.current).toBe(false)
  })
})
