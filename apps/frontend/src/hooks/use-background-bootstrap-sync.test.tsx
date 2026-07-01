import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { useBackgroundBootstrapSync } from "./use-background-bootstrap-sync"
import * as accountScope from "@/auth/account-scope"
import { SW_MSG_QUEUE_BOOTSTRAP_SYNC } from "@/lib/sw-messages"

let visibilityState: DocumentVisibilityState = "visible"
const originalVisibilityState = Object.getOwnPropertyDescriptor(document, "visibilityState")
const originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, "serviceWorker")
const postMessage = vi.fn()

function setVisibility(state: DocumentVisibilityState) {
  visibilityState = state
  document.dispatchEvent(new Event("visibilitychange"))
}

function makeWrapper(route: string) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(
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
  }
}

describe("useBackgroundBootstrapSync", () => {
  beforeEach(() => {
    visibilityState = "visible"
    postMessage.mockReset()

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibilityState,
    })

    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { controller: { postMessage } },
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalVisibilityState) {
      Object.defineProperty(document, "visibilityState", originalVisibilityState)
    } else {
      Reflect.deleteProperty(document, "visibilityState")
    }
    if (originalServiceWorker) {
      Object.defineProperty(navigator, "serviceWorker", originalServiceWorker)
    } else {
      Reflect.deleteProperty(navigator, "serviceWorker")
    }
  })

  it("posts a queue-sync message to the SW with workspace + stream when the tab hides", () => {
    renderHook(() => useBackgroundBootstrapSync(), {
      wrapper: makeWrapper("/w/ws_1/s/stream_1"),
    })

    act(() => setVisibility("hidden"))

    expect(postMessage).toHaveBeenCalledWith({
      type: SW_MSG_QUEUE_BOOTSTRAP_SYNC,
      workspaceId: "ws_1",
      streamId: "stream_1",
      workosUserId: null,
    })
  })

  it("carries the active account id so the SW can open the per-account database", () => {
    vi.spyOn(accountScope, "useAccountScopeOptional").mockReturnValue({
      activeWorkosUserId: "user_workos_1",
    } as ReturnType<typeof accountScope.useAccountScopeOptional>)

    renderHook(() => useBackgroundBootstrapSync(), {
      wrapper: makeWrapper("/w/ws_1/s/stream_1"),
    })

    act(() => setVisibility("hidden"))

    expect(postMessage).toHaveBeenCalledWith({
      type: SW_MSG_QUEUE_BOOTSTRAP_SYNC,
      workspaceId: "ws_1",
      streamId: "stream_1",
      workosUserId: "user_workos_1",
    })
  })

  it("posts with streamId=null when no stream is active", () => {
    renderHook(() => useBackgroundBootstrapSync(), {
      wrapper: makeWrapper("/w/ws_1"),
    })

    act(() => setVisibility("hidden"))

    expect(postMessage).toHaveBeenCalledWith({
      type: SW_MSG_QUEUE_BOOTSTRAP_SYNC,
      workspaceId: "ws_1",
      streamId: null,
      workosUserId: null,
    })
  })

  it("does nothing when the tab becomes visible", () => {
    renderHook(() => useBackgroundBootstrapSync(), {
      wrapper: makeWrapper("/w/ws_1/s/stream_1"),
    })

    act(() => {
      setVisibility("hidden")
      setVisibility("visible")
    })

    // Only the hidden transition fires
    expect(postMessage).toHaveBeenCalledTimes(1)
  })

  it("does nothing when there is no SW controller", () => {
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { controller: null },
    })

    renderHook(() => useBackgroundBootstrapSync(), {
      wrapper: makeWrapper("/w/ws_1/s/stream_1"),
    })

    act(() => setVisibility("hidden"))

    expect(postMessage).not.toHaveBeenCalled()
  })

  it("does nothing when there is no active workspace", () => {
    renderHook(() => useBackgroundBootstrapSync(), {
      wrapper: makeWrapper("/"),
    })

    act(() => setVisibility("hidden"))

    expect(postMessage).not.toHaveBeenCalled()
  })
})
