import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
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

  it("should save the chosen policy when an admin picks one", async () => {
    const update = vi
      .spyOn(workspaceSettingsApi, "update")
      .mockResolvedValue({ guestDmPolicy: GUEST_DM_POLICIES.ADMINS } as WorkspaceSettings)
    const user = userEvent.setup()
    renderSection([WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN], GUEST_DM_POLICIES.OFF)

    const group = screen.getByRole("radiogroup", { name: "Guest direct messages" })
    expect(
      within(group)
        .getAllByRole("radio")
        .map((radio) => radio.textContent)
    ).toEqual(["Off", "Admins only", "Everyone"])
    await user.click(within(group).getByRole("radio", { name: "Admins only" }))

    await waitFor(() => expect(update).toHaveBeenCalledWith("ws_1", { guestDmPolicy: GUEST_DM_POLICIES.ADMINS }))
    expect(within(group).getByRole("radio", { name: "Admins only" })).toHaveAttribute("aria-checked", "true")
  })

  it("should show the stored policy read-only with the reason when the viewer is not an admin", () => {
    renderSection([], GUEST_DM_POLICIES.OPEN)

    const group = screen.getByRole("radiogroup", { name: "Guest direct messages" })
    expect({
      checked: within(group).getByRole("radio", { name: "Everyone" }).getAttribute("aria-checked"),
      disabled: within(group)
        .getAllByRole("radio")
        .every((radio) => radio.hasAttribute("disabled")),
      reason: screen.queryByText("Only workspace admins can change this.") !== null,
    }).toEqual({ checked: "true", disabled: true, reason: true })
  })
})
