import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderHook } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { describe, expect, it } from "vitest"
import type { FeatureFlagLayers, WorkspaceBootstrap } from "@threahq/types"
import { workspaceKeys } from "@/hooks/use-workspaces"
import { useCommandItems } from "./use-command-items"
import type { CommandContext } from "./commands"

const commandContext = { workspaceId: "ws_1" } as unknown as CommandContext

function renderItems(featureFlags: FeatureFlagLayers | undefined) {
  const queryClient = new QueryClient()
  queryClient.setQueryData(workspaceKeys.bootstrap("ws_1"), { featureFlags } as WorkspaceBootstrap)
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
  const { result } = renderHook(() => useCommandItems({ query: "diagnostics", commandContext }), { wrapper })
  return result.current.items.map((item) => item.id)
}

describe("useCommandItems — rollout-gated settings tabs", () => {
  it("hides the Diagnostics settings command while the flag is off", () => {
    expect(renderItems({ workspace: {}, user: {} })).not.toContain("settings-diagnostics")
  })

  it("offers the Diagnostics settings command once the flag is available", () => {
    expect(renderItems({ workspace: { perfDiagnostics: "available" }, user: {} })).toContain("settings-diagnostics")
  })
})
