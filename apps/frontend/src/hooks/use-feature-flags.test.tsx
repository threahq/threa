import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderHook } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { describe, expect, it } from "vitest"
import { defaultFeatureFlags, type WorkspaceBootstrap } from "@threa/types"
import { workspaceKeys } from "./use-workspaces"
import { useOverriddenFeatureFlags } from "./use-feature-flags"

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children)
  }
}

// The registry is currently empty (no rollout in flight), so there is never a
// non-default flag to surface. The per-flag hooks (useFeatureFlag /
// useFeatureFlagWhenKnown) return with the next flag added to FEATURE_FLAGS;
// until then only the overridden-flags view is exercisable.
describe("useOverriddenFeatureFlags", () => {
  it("returns no overridden flags before the bootstrap is cached", () => {
    const queryClient = new QueryClient()
    const { result } = renderHook(() => useOverriddenFeatureFlags("ws_1"), {
      wrapper: createWrapper(queryClient),
    })

    expect(result.current).toEqual([])
  })

  it("returns no overridden flags when the bootstrap carries the default map", () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(workspaceKeys.bootstrap("ws_1"), {
      featureFlags: defaultFeatureFlags(),
    } as WorkspaceBootstrap)

    const { result } = renderHook(() => useOverriddenFeatureFlags("ws_1"), {
      wrapper: createWrapper(queryClient),
    })

    expect(result.current).toEqual([])
  })
})
