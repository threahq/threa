import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  WORKSPACE_PERMISSION_SCOPES,
  type WorkspaceBootstrap,
  type WorkspaceSettings,
  type WorkspacePermissionSlug,
} from "@threahq/types"
import { workspaceKeys } from "@/hooks/use-workspaces"
import { workspaceSettingsApi } from "@/api"
import { SandboxInternetSection } from "./sandbox-internet-section"

function renderSection(viewerPermissions: WorkspacePermissionSlug[], sandboxInternet: boolean) {
  const queryClient = new QueryClient()
  queryClient.setQueryData(workspaceKeys.bootstrap("ws_1"), {
    viewerPermissions,
    workspaceSettings: { sandboxInternet } as WorkspaceSettings,
  } as unknown as WorkspaceBootstrap)
  render(
    <QueryClientProvider client={queryClient}>
      <SandboxInternetSection workspaceId="ws_1" />
    </QueryClientProvider>
  )
}

describe("SandboxInternetSection", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("an admin turns sandbox internet off", async () => {
    const update = vi
      .spyOn(workspaceSettingsApi, "update")
      .mockResolvedValue({ sandboxInternet: false } as WorkspaceSettings)
    renderSection([WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN], true)

    const toggle = screen.getByRole("switch", { name: "Sandbox internet access" })
    await userEvent.setup().click(toggle)

    await waitFor(() => expect(update).toHaveBeenCalledWith("ws_1", { sandboxInternet: false }))
    expect(toggle).toHaveAttribute("aria-checked", "false")
  })

  it("a member sees the stored setting but cannot change it", () => {
    renderSection([], false)

    expect({ toggle: screen.queryByRole("switch"), value: screen.getByText("Off").textContent }).toEqual({
      toggle: null,
      value: "Off",
    })
  })
})
