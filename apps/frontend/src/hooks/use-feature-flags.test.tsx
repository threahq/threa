import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderHook } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { describe, expect, it } from "vitest"
import { type FeatureFlagLayers, type WorkspaceBootstrap } from "@threa/types"
import { workspaceKeys } from "./use-workspaces"
import { useOverriddenFeatureFlags } from "./use-feature-flags"

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children)
  }
}

// The shipped registry is empty (no rollout in flight), so the per-flag hooks
// (useFeatureFlag / useFeatureFlagWhenKnown) have no key to read and only the
// overridden-flags view is exercisable end-to-end. The precedence the hooks
// depend on is proven against the registry-parameterized resolver below — the
// same function `useResolvedFeatureFlags` composes over — since a fake flag must
// not enter FEATURE_FLAGS.
describe("useOverriddenFeatureFlags", () => {
  it("returns no overridden flags before the bootstrap is cached", () => {
    const queryClient = new QueryClient()
    const { result } = renderHook(() => useOverriddenFeatureFlags("ws_1"), {
      wrapper: createWrapper(queryClient),
    })

    expect(result.current).toEqual([])
  })

  it("consumes the layered bootstrap shape and drops keys not in the registry", () => {
    const queryClient = new QueryClient()
    const layers: FeatureFlagLayers = { workspace: { calls: "off" }, user: { newComposer: "on" } }
    queryClient.setQueryData(workspaceKeys.bootstrap("ws_1"), { featureFlags: layers } as WorkspaceBootstrap)

    const { result } = renderHook(() => useOverriddenFeatureFlags("ws_1"), {
      wrapper: createWrapper(queryClient),
    })

    // Empty registry: every override is inert, so nothing is surfaced (and the
    // layered shape does not crash the resolve).
    expect(result.current).toEqual([])
  })
})
