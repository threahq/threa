import { afterEach, describe, expect, it } from "vitest"
import { act, renderHook } from "@testing-library/react"
import {
  holdSidebarThreads,
  releaseSidebarThread,
  resetSidebarHeldThreadsStore,
  useHeldSidebarThreads,
} from "./sidebar-held-threads-store"

describe("sidebar-held-threads-store", () => {
  afterEach(() => resetSidebarHeldThreadsStore())

  it("should hold threads per workspace until each is released", () => {
    const { result } = renderHook(() => ({ a: useHeldSidebarThreads("ws_a"), b: useHeldSidebarThreads("ws_b") }))

    act(() => holdSidebarThreads("ws_a", ["t_1", "t_2"]))
    act(() => releaseSidebarThread("ws_a", "t_1"))

    expect({ a: [...result.current.a], b: [...result.current.b] }).toEqual({ a: ["t_2"], b: [] })
  })

  it("should keep the same set when every thread is already held", () => {
    const { result } = renderHook(() => useHeldSidebarThreads("ws_a"))
    act(() => holdSidebarThreads("ws_a", ["t_1"]))
    const held = result.current

    act(() => holdSidebarThreads("ws_a", ["t_1"]))

    expect(result.current).toBe(held)
  })
})
