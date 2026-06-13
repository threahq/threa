import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderHook, act, waitFor } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { describe, expect, it } from "vitest"
import { defaultFeatureFlags, defaultFeatureFlagValue, type WorkspaceBootstrap } from "@threa/types"
import { workspaceKeys } from "./use-workspaces"
import { useFeatureFlag, useFeatureFlagWhenKnown } from "./use-feature-flags"

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children)
  }
}

function cacheBootstrapWithMode(queryClient: QueryClient, mode: "shadow" | "off" | "active") {
  queryClient.setQueryData(workspaceKeys.bootstrap("ws_1"), {
    featureFlags: { ...defaultFeatureFlags(), "sync-v2-cursor": mode },
  } as WorkspaceBootstrap)
}

describe("useFeatureFlagWhenKnown", () => {
  it("returns null until the bootstrap is cached, then the delivered value", async () => {
    const queryClient = new QueryClient()
    const { result } = renderHook(() => useFeatureFlagWhenKnown("ws_1", "sync-v2-cursor"), {
      wrapper: createWrapper(queryClient),
    })

    expect(result.current).toBeNull()

    act(() => cacheBootstrapWithMode(queryClient, "active"))
    await waitFor(() => expect(result.current).toBe("active"))
  })

  it("follows live cache updates (feature_flags:updated path)", async () => {
    const queryClient = new QueryClient()
    cacheBootstrapWithMode(queryClient, "shadow")
    const { result } = renderHook(() => useFeatureFlagWhenKnown("ws_1", "sync-v2-cursor"), {
      wrapper: createWrapper(queryClient),
    })

    expect(result.current).toBe("shadow")

    act(() => cacheBootstrapWithMode(queryClient, "off"))
    await waitFor(() => expect(result.current).toBe("off"))
  })
})

describe("useFeatureFlag", () => {
  it("returns the registry default until the bootstrap is cached, then the delivered value", async () => {
    const queryClient = new QueryClient()
    const { result } = renderHook(() => useFeatureFlag("ws_1", "sync-v2-cursor"), {
      wrapper: createWrapper(queryClient),
    })

    expect(result.current).toBe(defaultFeatureFlagValue("sync-v2-cursor"))

    act(() => cacheBootstrapWithMode(queryClient, "active"))
    await waitFor(() => expect(result.current).toBe("active"))
  })
})
