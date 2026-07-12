import { describe, it, expect, afterEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useBoardFlash, setBoardFlash, resetBoardFlashStoreCache } from "./board-flash-store"

afterEach(() => {
  resetBoardFlashStoreCache()
})

describe("board flash store", () => {
  it("flashes only the matching conversation, and clears", () => {
    const a = renderHook(() => useBoardFlash("conv_a"))
    const b = renderHook(() => useBoardFlash("conv_b"))
    expect(a.result.current).toBe(false)
    expect(b.result.current).toBe(false)

    act(() => setBoardFlash("conv_a"))
    expect(a.result.current).toBe(true)
    expect(b.result.current).toBe(false)

    act(() => setBoardFlash(null))
    expect(a.result.current).toBe(false)
    expect(b.result.current).toBe(false)
  })

  it("moves the flash to a newer conversation on a second post", () => {
    const a = renderHook(() => useBoardFlash("conv_a"))
    const b = renderHook(() => useBoardFlash("conv_b"))

    act(() => setBoardFlash("conv_a"))
    expect(a.result.current).toBe(true)

    act(() => setBoardFlash("conv_b"))
    expect(a.result.current).toBe(false)
    expect(b.result.current).toBe(true)
  })

  it("resets the flash on account switch", () => {
    const a = renderHook(() => useBoardFlash("conv_a"))
    act(() => setBoardFlash("conv_a"))
    expect(a.result.current).toBe(true)

    act(() => resetBoardFlashStoreCache())
    expect(a.result.current).toBe(false)
  })
})
