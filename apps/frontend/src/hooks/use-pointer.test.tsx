import { afterEach, describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"

function stubMatchMedia(coarsePrimary: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("pointer: coarse") ? coarsePrimary : false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }))
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe("useCoarsePointer", () => {
  it("is true on a touch-primary device (coarse primary pointer)", async () => {
    stubMatchMedia(true)
    const { useCoarsePointer } = await import("./use-pointer")
    const { result } = renderHook(() => useCoarsePointer())
    expect(result.current).toBe(true)
  })

  it("is false on a mouse-primary device — even a touch-capable laptop reports its trackpad", async () => {
    stubMatchMedia(false)
    const { useCoarsePointer } = await import("./use-pointer")
    const { result } = renderHook(() => useCoarsePointer())
    expect(result.current).toBe(false)
  })
})
