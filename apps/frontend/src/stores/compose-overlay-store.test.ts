import { describe, it, expect, beforeEach, vi } from "vitest"
import { renderHook, act } from "@testing-library/react"
import {
  useComposeOverlay,
  openCompose,
  closeCompose,
  registerComposeOnPosted,
  notifyComposePosted,
  resetComposeOverlayStoreCache,
} from "./compose-overlay-store"

beforeEach(() => {
  resetComposeOverlayStoreCache()
})

describe("compose overlay store", () => {
  it("opens with an optional target and closes", () => {
    const { result } = renderHook(() => useComposeOverlay())
    expect(result.current.open).toBe(false)

    act(() => openCompose("stream_x"))
    expect(result.current).toEqual({ open: true, defaultTarget: "stream_x" })

    act(() => closeCompose())
    expect(result.current.open).toBe(false)
  })

  it("opens without a target when none is given", () => {
    const { result } = renderHook(() => useComposeOverlay())
    act(() => openCompose())
    expect(result.current).toEqual({ open: true, defaultTarget: undefined })
  })

  it("invokes the registered onPosted with the conversation id, and stops after it unregisters", () => {
    const onPosted = vi.fn()
    const unregister = registerComposeOnPosted(onPosted)

    notifyComposePosted("conv_1")
    expect(onPosted).toHaveBeenCalledTimes(1)
    expect(onPosted).toHaveBeenCalledWith("conv_1")

    unregister()
    notifyComposePosted("conv_2")
    expect(onPosted).toHaveBeenCalledTimes(1)
  })
})
