import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  GUEST_DM_POLICIES,
  WORKSPACE_PERMISSION_SCOPES,
  type GuestDmPolicy,
  type WorkspaceBootstrap,
  type WorkspacePermissionSlug,
  type WorkspaceSettings,
} from "@threahq/types"
import { workspaceKeys } from "@/hooks/use-workspaces"
import { workspaceSettingsApi } from "@/api"
import { GuestDmPolicySection } from "./guest-dm-policy-section"

function renderSection(viewerPermissions: WorkspacePermissionSlug[], guestDmPolicy: GuestDmPolicy) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(workspaceKeys.bootstrap("ws_1"), {
    viewerPermissions,
    workspaceSettings: { guestDmPolicy } as WorkspaceSettings,
  } as unknown as WorkspaceBootstrap)
  render(
    <QueryClientProvider client={queryClient}>
      <GuestDmPolicySection workspaceId="ws_1" />
    </QueryClientProvider>
  )
}

describe("GuestDmPolicySection", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("should save the chosen policy when an admin changes it", async () => {
    const update = vi
      .spyOn(workspaceSettingsApi, "update")
      .mockResolvedValue({ guestDmPolicy: GUEST_DM_POLICIES.ADMINS } as WorkspaceSettings)
    const user = userEvent.setup()
    renderSection([WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN], GUEST_DM_POLICIES.OFF)

    const select = screen.getByRole("combobox", { name: "Direct messages with guests" })
    expect(select).toHaveTextContent("Off")
    await user.click(select)
    await user.click(await screen.findByRole("option", { name: "Admins only" }))

    await waitFor(() => expect(update).toHaveBeenCalledWith("ws_1", { guestDmPolicy: GUEST_DM_POLICIES.ADMINS }))
    await waitFor(() => expect(select).toHaveTextContent("Admins only"))
  })

  it("should offer every policy when an admin opens the select", async () => {
    const user = userEvent.setup()
    renderSection([WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN], GUEST_DM_POLICIES.OFF)

    await user.click(screen.getByRole("combobox", { name: "Direct messages with guests" }))

    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual([
      "Off",
      "Admins only",
      "Everyone",
    ])
  })

  it("should show the stored policy read-only when the viewer is not an admin", () => {
    renderSection([], GUEST_DM_POLICIES.OPEN)

    expect({ control: screen.queryByRole("combobox"), value: screen.queryByText("Everyone") !== null }).toEqual({
      control: null,
      value: true,
    })
  })
})
