import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { WorkspaceBootstrap } from "@threa/types"
import { workspaceKeys } from "@/hooks/use-workspaces"
import { WorkspaceSettingsDialog } from "./workspace-settings-dialog"
import * as generalTabModule from "./general-tab"
import * as usersTabModule from "./users-tab"
import * as botsTabModule from "./bots-tab"
import * as apiKeysTabModule from "./api-keys-tab"

function SearchEcho() {
  const location = useLocation()
  return <div data-testid="search">{location.search}</div>
}

function WorkspaceSettingsRoute() {
  return (
    <>
      <WorkspaceSettingsDialog workspaceId="ws_1" />
      <SearchEcho />
    </>
  )
}

function renderDialog(initialEntry: string, queryClient = new QueryClient()) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/w/:workspaceId" element={<WorkspaceSettingsRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

function seedBootstrapFlags(queryClient: QueryClient, featureFlags: WorkspaceBootstrap["featureFlags"]) {
  queryClient.setQueryData(workspaceKeys.bootstrap("ws_1"), { featureFlags } as WorkspaceBootstrap)
}

describe("WorkspaceSettingsDialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(generalTabModule, "GeneralTab").mockImplementation(() => <div>General panel</div>)
    vi.spyOn(usersTabModule, "UsersTab").mockImplementation(() => <div>Users panel</div>)
    vi.spyOn(botsTabModule, "BotsTab").mockImplementation(() => <div>Bots panel</div>)
    vi.spyOn(apiKeysTabModule, "ApiKeysTab").mockImplementation(() => <div>API keys panel</div>)
  })

  it("uses the sidebar navigation and keeps URL tab state in sync", async () => {
    const user = userEvent.setup()

    renderDialog("/w/ws_1?ws-settings=general")

    expect(await screen.findByText("Workspace identity and region")).toBeInTheDocument()
    expect(screen.getByText("General panel")).toBeVisible()

    const tabs = document.body.querySelector('[data-slot="settings-tabs"]')
    const panels = document.body.querySelector('[data-slot="settings-panels"]')
    const nav = document.body.querySelector('[data-slot="settings-nav"]')
    const content = document.body.querySelector('[data-slot="settings-content"]')

    expect(tabs).toHaveClass("flex", "flex-1", "min-h-0", "flex-col")
    expect(panels).toHaveClass("flex", "flex-1", "min-h-0", "overflow-hidden")
    expect(nav).toHaveClass("min-h-0", "overflow-y-auto")
    expect(content).toHaveClass("flex-1", "min-h-0", "overflow-y-auto")

    await user.click(screen.getByRole("button", { name: /Bots/i }))

    await waitFor(() => {
      expect(screen.getByTestId("search")).toHaveTextContent("?ws-settings=bots")
    })
    expect(screen.getByText("Bots panel")).toBeVisible()
    expect(screen.getByText("Members and pending invites")).toBeInTheDocument()
  })

  describe("feature flags tab", () => {
    it("shows the tab with the viewer's non-default flags only", async () => {
      const user = userEvent.setup()
      const queryClient = new QueryClient()
      seedBootstrapFlags(queryClient, { "sync-v2-cursor": "active" })

      renderDialog("/w/ws_1?ws-settings=general", queryClient)

      await user.click(await screen.findByRole("button", { name: /Feature flags/i }))

      await waitFor(() => {
        expect(screen.getByTestId("search")).toHaveTextContent("?ws-settings=feature-flags")
      })
      expect(screen.getByText("sync-v2-cursor")).toBeVisible()
      expect(screen.getByText("active")).toBeVisible()
    })

    it("hides the tab when every flag is at its default", async () => {
      const queryClient = new QueryClient()
      seedBootstrapFlags(queryClient, { "sync-v2-cursor": "shadow" })

      renderDialog("/w/ws_1?ws-settings=general", queryClient)

      expect(await screen.findByText("Workspace identity and region")).toBeInTheDocument()
      expect(screen.queryByRole("button", { name: /Feature flags/i })).not.toBeInTheDocument()
    })

    it("falls back to the general tab when deep-linked without any overridden flags", async () => {
      renderDialog("/w/ws_1?ws-settings=feature-flags")

      expect(await screen.findByText("General panel")).toBeVisible()
      expect(screen.queryByRole("button", { name: /Feature flags/i })).not.toBeInTheDocument()
      expect(screen.queryByText("sync-v2-cursor")).not.toBeInTheDocument()
    })
  })
})
