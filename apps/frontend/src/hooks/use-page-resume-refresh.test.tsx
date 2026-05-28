import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { usePageResumeRefresh } from "./use-page-resume-refresh"
import { workspaceKeys } from "./use-workspaces"
import { streamKeys } from "./use-streams"

let visibilityState: DocumentVisibilityState = "visible"
const originalVisibilityState = Object.getOwnPropertyDescriptor(document, "visibilityState")

function setVisibility(state: DocumentVisibilityState) {
  visibilityState = state
  document.dispatchEvent(new Event("visibilitychange"))
}

function blurWindow() {
  window.dispatchEvent(new Event("blur"))
}

function focusWindow() {
  window.dispatchEvent(new Event("focus"))
}

function makeWrapper(queryClient: QueryClient, route: string) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        MemoryRouter,
        { initialEntries: [route] },
        createElement(
          Routes,
          null,
          createElement(Route, { path: "/w/:workspaceId/s/:streamId", element: children }),
          createElement(Route, { path: "/w/:workspaceId", element: children }),
          createElement(Route, { path: "/", element: children })
        )
      )
    )
  }
}

describe("usePageResumeRefresh", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    visibilityState = "visible"
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibilityState,
    })
  })

  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
    if (originalVisibilityState) {
      Object.defineProperty(document, "visibilityState", originalVisibilityState)
    } else {
      Reflect.deleteProperty(document, "visibilityState")
    }
  })

  it("invalidates workspace + active stream bootstrap when the tab returns from a long hide", () => {
    const queryClient = new QueryClient()
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries")

    renderHook(() => usePageResumeRefresh(), {
      wrapper: makeWrapper(queryClient, "/w/ws_1/s/stream_1"),
    })

    act(() => {
      setVisibility("hidden")
      vi.advanceTimersByTime(6_000)
      setVisibility("visible")
    })

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: workspaceKeys.bootstrap("ws_1") })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: streamKeys.bootstrap("ws_1", "stream_1") })
    expect(invalidateSpy).toHaveBeenCalledTimes(2)
  })

  it("invalidates only workspace bootstrap when no stream is active", () => {
    const queryClient = new QueryClient()
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries")

    renderHook(() => usePageResumeRefresh(), {
      wrapper: makeWrapper(queryClient, "/w/ws_1"),
    })

    act(() => {
      setVisibility("hidden")
      vi.advanceTimersByTime(6_000)
      setVisibility("visible")
    })

    expect(invalidateSpy).toHaveBeenCalledTimes(1)
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: workspaceKeys.bootstrap("ws_1") })
  })

  it("does nothing for a brief glance away (under threshold)", () => {
    const queryClient = new QueryClient()
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries")

    renderHook(() => usePageResumeRefresh(), {
      wrapper: makeWrapper(queryClient, "/w/ws_1/s/stream_1"),
    })

    act(() => {
      setVisibility("hidden")
      vi.advanceTimersByTime(2_000)
      setVisibility("visible")
    })

    expect(invalidateSpy).not.toHaveBeenCalled()
  })

  it("does nothing when there is no active workspace in the URL", () => {
    const queryClient = new QueryClient()
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries")

    renderHook(() => usePageResumeRefresh(), {
      wrapper: makeWrapper(queryClient, "/"),
    })

    act(() => {
      setVisibility("hidden")
      vi.advanceTimersByTime(6_000)
      setVisibility("visible")
    })

    expect(invalidateSpy).not.toHaveBeenCalled()
  })

  it("invalidates active stream bootstrap when the window regains focus (desktop app-switch)", () => {
    const queryClient = new QueryClient()
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries")

    renderHook(() => usePageResumeRefresh(), {
      wrapper: makeWrapper(queryClient, "/w/ws_1/s/stream_1"),
    })

    act(() => {
      blurWindow()
      vi.advanceTimersByTime(6_000)
      focusWindow()
    })

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: workspaceKeys.bootstrap("ws_1") })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: streamKeys.bootstrap("ws_1", "stream_1") })
    expect(invalidateSpy).toHaveBeenCalledTimes(2)
  })

  it("invalidates panel stream bootstraps in addition to the route stream", () => {
    const queryClient = new QueryClient()
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries")

    renderHook(() => usePageResumeRefresh(), {
      wrapper: makeWrapper(queryClient, "/w/ws_1/s/stream_1?panel=stream_2&panel=stream_3"),
    })

    act(() => {
      setVisibility("hidden")
      vi.advanceTimersByTime(6_000)
      setVisibility("visible")
    })

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: workspaceKeys.bootstrap("ws_1") })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: streamKeys.bootstrap("ws_1", "stream_1") })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: streamKeys.bootstrap("ws_1", "stream_2") })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: streamKeys.bootstrap("ws_1", "stream_3") })
    expect(invalidateSpy).toHaveBeenCalledTimes(4)
  })
})
