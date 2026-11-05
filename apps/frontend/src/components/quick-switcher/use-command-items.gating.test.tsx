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

describe("useCommandItems — settings", () => {
  it("hides the Diagnostics setting while the flag is off", () => {
    expect(renderItems({ workspace: {}, user: {} })).not.toContain("setting-diagnostics")
  })

  it("offers the Diagnostics setting once the flag is available", () => {
    expect(renderItems({ workspace: { perfDiagnostics: "available" }, user: {} })).toContain("setting-diagnostics")
  })

  it("finds a setting by the symptom a user describes", () => {
    expect(renderItems({ workspace: {}, user: {} }, commandContext, "only the first link")).toContain(
      "setting-link-preview-count"
    )
  })

  it("puts a setting named by the query ahead of commands that only match an alias", () => {
    expect(renderItems({ workspace: {}, user: {} }, commandContext, "preview")[0]).toBe("setting-link-preview-count")
    expect(renderItems({ workspace: {}, user: {} }, commandContext, "theme")[0]).toBe("setting-theme")
  })

  it("keeps a command named by the query ahead of settings", () => {
    expect(renderItems({ workspace: {}, user: {} }, commandContext, "notifications")[0]).toBe("settings-notifications")
  })

  it("offers the workspace AI agents page to admins only", () => {
    const flags = { workspace: {}, user: {} }
    expect(renderItems(flags, commandContext, "ai agents")).not.toContain("settings-workspace-ai")
    expect(renderItems(flags, commandContext, "ai agents", [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN])).toContain(
      "settings-workspace-ai"
    )
  })
})

describe("useCommandItems — stream settings with no stream in view", () => {
  it("offers them and asks which stream on select", () => {
    const openStreamSettings = vi.fn()
    const context = { workspaceId: "ws_1", closeDialog: vi.fn(), openStreamSettings } as unknown as CommandContext
    const queryClient = new QueryClient()
    queryClient.setQueryData(workspacesModule.workspaceKeys.bootstrap("ws_1"), {
      featureFlags: { workspace: {}, user: {} },
      viewerPermissions: [],
    } as unknown as WorkspaceBootstrap)
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children)
    const { result } = renderHook(() => useCommandItems({ query: "mute channel", commandContext: context }), {
      wrapper,
    })

    const item = result.current.items.find((candidate) => candidate.id === "setting-stream-notifications")
    expect(item?.description).toContain("Any stream › General › Your notifications")
    item?.onSelect?.()
    expect(openStreamSettings).toHaveBeenCalledWith(null, "general", "stream-notifications")
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

describe("useCommandItems — doc in view", () => {
  const flags = { workspace: {}, user: {} }
  const timelineCommands = ["stream-create-snippet", "stream-settings", "stream-files", "stream-agenda"]
  const streamIds = (context: CommandContext) =>
    renderItems(flags, context, "").filter((id) => id.startsWith("stream-") && id !== "stream-labels")

  it("should offer only Browse files of the timeline commands for a doc", () => {
    const inDoc = { workspaceId: "ws_1", currentStreamId: "stream_doc", currentStreamType: "doc" } as CommandContext
    expect(streamIds(inDoc)).toEqual(["stream-files"])
  })

  it("should offer Members only when the host exposes a member list to open", () => {
    const inChannel = {
      workspaceId: "ws_1",
      currentStreamId: "stream_1",
      currentStreamType: "channel",
    } as CommandContext
    expect(streamIds(inChannel)).not.toContain("stream-members")
    expect(streamIds({ ...inChannel, openStreamMembers: () => {} })).toContain("stream-members")
  })

  it("should keep the timeline commands for a channel", () => {
    const inChannel = {
      workspaceId: "ws_1",
      currentStreamId: "stream_1",
      currentStreamType: "channel",
    } as CommandContext
    expect(streamIds(inChannel)).toEqual(timelineCommands)
  })
})
