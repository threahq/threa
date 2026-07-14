import { afterEach, describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"

function stubMatchMedia(opts: { coarsePrimary?: boolean; narrowViewport?: boolean }) {
  const matchesFor = (query: string): boolean => {
    if (query.includes("pointer: coarse")) return opts.coarsePrimary ?? false
    if (query.includes("max-width")) return opts.narrowViewport ?? false
    return false
  }
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: matchesFor(query),
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
    stubMatchMedia({ coarsePrimary: true })
    const { useCoarsePointer } = await import("./use-pointer")
    const { result } = renderHook(() => useCoarsePointer())
    expect(result.current).toBe(true)
  })

  it("is false on a mouse-primary device — even a touch-capable laptop reports its trackpad", async () => {
    stubMatchMedia({ coarsePrimary: false })
    const { useCoarsePointer } = await import("./use-pointer")
    const { result } = renderHook(() => useCoarsePointer())
    expect(result.current).toBe(false)
  })
})

describe("useIsMobileOrCoarse", () => {
  // The mid-screen-bug root guard: the shared breadth that the overlay sidebar
  // (`useSidebar().isMobile`) and the board float gate both consume must be true
  // for a wide coarse-pointer tablet — the case a bare-viewport check missed.
  it("is true on a wide coarse-pointer device (tablet ≥640px)", async () => {
    stubMatchMedia({ coarsePrimary: true, narrowViewport: false })
    const { useIsMobileOrCoarse } = await import("./use-pointer")
    const { result } = renderHook(() => useIsMobileOrCoarse())
    expect(result.current).toBe(true)
  })

  it("is true on a narrow-viewport fine-pointer device (phone-width window)", async () => {
    stubMatchMedia({ coarsePrimary: false, narrowViewport: true })
    const { useIsMobileOrCoarse } = await import("./use-pointer")
    const { result } = renderHook(() => useIsMobileOrCoarse())
    expect(result.current).toBe(true)
  })

  it("is false on a wide fine-pointer desktop", async () => {
    stubMatchMedia({ coarsePrimary: false, narrowViewport: false })
    const { useIsMobileOrCoarse } = await import("./use-pointer")
    const { result } = renderHook(() => useIsMobileOrCoarse())
    expect(result.current).toBe(false)
  })
})
