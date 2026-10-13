import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderHook } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  WORKSPACE_PERMISSION_SCOPES,
  type FeatureFlagLayers,
  type WorkspaceBootstrap,
  type WorkspacePermissionSlug,
} from "@threahq/types"
import * as workspacesModule from "@/hooks/use-workspaces"
import { useCommandItems } from "./use-command-items"
import type { CommandContext } from "./commands"

const commandContext = { workspaceId: "ws_1" } as unknown as CommandContext

beforeEach(() => {
  vi.spyOn(workspacesModule, "useCurrentWorkspaceUser").mockReturnValue(null)
})

afterEach(() => {
  vi.restoreAllMocks()
})

function renderItems(
  featureFlags: FeatureFlagLayers | undefined,
  context = commandContext,
  query = "diagnostics",
  viewerPermissions: WorkspacePermissionSlug[] = []
) {
  const queryClient = new QueryClient()
  queryClient.setQueryData(workspacesModule.workspaceKeys.bootstrap("ws_1"), {
    featureFlags,
    viewerPermissions,
  } as WorkspaceBootstrap)
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

describe("useCommandItems — channel creation", () => {
  const flags = { workspace: {}, user: {} }

  it("should offer New Channel when the viewer can browse", () => {
    expect(renderItems(flags, commandContext, "new channel", [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_BROWSE])).toContain(
      "new-channel"
    )
  })

  it("should hide New Channel when the viewer lacks browse", () => {
    expect(renderItems(flags, commandContext, "new channel", [])).not.toContain("new-channel")
  })
})

describe("useCommandItems — pane commands", () => {
  const flags = { workspace: {}, user: {} }
  const paneIds = (context: CommandContext) =>
    renderItems(flags, context, "close").filter((id) => id.startsWith("pane-"))

  it("should offer no pane command when no pane can close", () => {
    expect(paneIds(commandContext)).toEqual([])
  })

  it("should offer only the closes that would close something", () => {
    const close = () => {}
    expect(paneIds({ ...commandContext, closePane: close, closeAllPanes: close })).toEqual([
      "pane-close",
      "pane-close-all",
    ])
  })
})
