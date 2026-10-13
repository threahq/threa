import { beforeEach, describe, expect, it } from "vitest"
import { act, renderHook } from "@testing-library/react"
import type React from "react"
import {
  ASIDE_STAGE_DEFAULT_WIDTH,
  ASIDE_STAGE_MIN_WIDTH,
  resetAsideStoreCache,
  type OpenAsideState,
} from "@/stores/aside-store"
import { MIN_MAIN_WIDTH } from "@/hooks/use-panel-layout"
import { useAsideColumnLayout } from "./aside-column"

const ASIDE: OpenAsideState = {
  asideId: "stream_aside_1",
  hostKey: "/w/ws_1/s/stream_host",
  hostStreamId: "stream_host",
  originScope: "stream:stream_host",
}

function arrow(key: "ArrowLeft" | "ArrowRight", shiftKey = false) {
  return { key, shiftKey, preventDefault: () => {} } as React.KeyboardEvent
}

beforeEach(() => resetAsideStoreCache())

describe("useAsideColumnLayout", () => {
  it("should take no width while no aside is open", () => {
    const { result } = renderHook(() => useAsideColumnLayout(null, 1600, 0))
    expect(result.current.width).toBe(0)
  })

  it("should keep the stored width while the page is unmeasured", () => {
    const { result } = renderHook(() => useAsideColumnLayout(ASIDE, 0, 0))
    expect({ width: result.current.width, maxWidth: result.current.maxWidth }).toEqual({
      width: ASIDE_STAGE_DEFAULT_WIDTH,
      maxWidth: ASIDE_STAGE_DEFAULT_WIDTH,
    })
  })

  it("should leave the main column its floor and the other columns their minimums", () => {
    const { result } = renderHook(() => useAsideColumnLayout(ASIDE, 1300, 300))
    const cap = 1300 - MIN_MAIN_WIDTH - 300
    expect({ width: result.current.width, maxWidth: result.current.maxWidth }).toEqual({ width: cap, maxWidth: cap })
  })

  it("should hold its own floor when the page is too narrow for it", () => {
    const { result } = renderHook(() => useAsideColumnLayout(ASIDE, 900, 300))
    expect(result.current.width).toBe(ASIDE_STAGE_MIN_WIDTH)
  })

  it("should widen on ArrowLeft and narrow on ArrowRight, by 50 with Shift, within its bounds", () => {
    const { result } = renderHook(() => useAsideColumnLayout(ASIDE, 1100, 0))
    act(() => result.current.onKeyDown(arrow("ArrowLeft")))
    expect(result.current.width).toBe(ASIDE_STAGE_DEFAULT_WIDTH + 10)
    act(() => result.current.onKeyDown(arrow("ArrowRight", true)))
    expect(result.current.width).toBe(ASIDE_STAGE_DEFAULT_WIDTH - 40)
    act(() => result.current.onKeyDown(arrow("ArrowLeft", true)))
    act(() => result.current.onKeyDown(arrow("ArrowLeft", true)))
    act(() => result.current.onKeyDown(arrow("ArrowLeft", true)))
    expect(result.current.width).toBe(1100 - MIN_MAIN_WIDTH)
  })
})
