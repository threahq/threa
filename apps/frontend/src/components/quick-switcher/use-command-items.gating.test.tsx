import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderHook } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { describe, expect, it } from "vitest"
import type { FeatureFlagLayers, WorkspaceBootstrap } from "@threahq/types"
import { workspaceKeys } from "@/hooks/use-workspaces"
import { useCommandItems } from "./use-command-items"
import type { CommandContext } from "./commands"

const commandContext = { workspaceId: "ws_1" } as unknown as CommandContext

function renderItems(featureFlags: FeatureFlagLayers | undefined, context = commandContext, query = "diagnostics") {
  const queryClient = new QueryClient()
  queryClient.setQueryData(workspaceKeys.bootstrap("ws_1"), { featureFlags } as WorkspaceBootstrap)
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
  const { result } = renderHook(() => useCommandItems({ query, commandContext: context }), { wrapper })
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

describe("useCommandItems — Settle", () => {
  const flags = { workspace: {}, user: {} }
  const inStream = { workspaceId: "ws_1", currentStreamId: "stream_1" } as unknown as CommandContext

  it("hides Settle when the stream in view is not in the Inbox", () => {
    expect(renderItems(flags, inStream, "settle")).not.toContain("stream-settle")
  })

  it("offers Settle when the stream in view is in the Inbox", () => {
    const settleable = { ...inStream, settleStream: () => {} } as CommandContext
    expect(renderItems(flags, settleable, "settle")).toContain("stream-settle")
  })
})
