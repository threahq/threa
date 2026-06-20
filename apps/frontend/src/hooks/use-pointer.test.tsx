import { afterEach, describe, expect, it, vi } from "vitest"
import { renderHook, act } from "@testing-library/react"

type ChangeHandler = (ev: Pick<MediaQueryListEvent, "matches">) => void

function mockMatchMedia(initialCoarse: boolean) {
  const handlers = new Set<ChangeHandler>()
  let matches = initialCoarse
  const mql = {
    get matches() {
      return matches
    },
    media: "(pointer: coarse)",
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: (_: string, cb: ChangeHandler) => handlers.add(cb),
    removeEventListener: (_: string, cb: ChangeHandler) => handlers.delete(cb),
    dispatchEvent: () => false,
  }
  vi.stubGlobal("matchMedia", (query: string) => {
    mql.media = query
    return mql
  })
  return {
    emit(next: boolean) {
      matches = next
      for (const cb of handlers) cb({ matches: next })
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe("useCoarsePointer", () => {
  it("reports the primary pointer as coarse on touch devices", async () => {
    mockMatchMedia(true)
    const { useCoarsePointer: fresh } = await import("./use-pointer")
    const { result } = renderHook(() => fresh())
    expect(result.current).toBe(true)
  })

  it("reports fine on a mouse-driven device regardless of width", async () => {
    mockMatchMedia(false)
    const { useCoarsePointer: fresh } = await import("./use-pointer")
    const { result } = renderHook(() => fresh())
    expect(result.current).toBe(false)
  })

  it("reacts when the primary pointer changes (e.g. a mouse is attached)", async () => {
    const media = mockMatchMedia(true)
    const { useCoarsePointer: fresh } = await import("./use-pointer")
    const { result } = renderHook(() => fresh())
    expect(result.current).toBe(true)
    act(() => media.emit(false))
    expect(result.current).toBe(false)
  })
})
