import { describe, it, expect, beforeEach, vi } from "vitest"
import { renderHook, act } from "@testing-library/react"
import {
  useComposeOverlay,
  openCompose,
  closeCompose,
  registerComposeOnPosted,
  notifyComposePosted,
} from "./compose-overlay-store"

beforeEach(() => {
  closeCompose()
  // Clear any onPosted a prior test registered.
  registerComposeOnPosted(() => {})()
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

  it("invokes the registered onPosted, and stops after it unregisters", () => {
    const onPosted = vi.fn()
    const unregister = registerComposeOnPosted(onPosted)

    notifyComposePosted()
    expect(onPosted).toHaveBeenCalledTimes(1)

    unregister()
    notifyComposePosted()
    expect(onPosted).toHaveBeenCalledTimes(1)
  })
})
