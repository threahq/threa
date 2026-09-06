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
import { BillingTimezoneSection } from "./billing-timezone-section"

function seedBootstrap(
  queryClient: QueryClient,
  viewerPermissions: WorkspacePermissionSlug[],
  billingTimezone: string
) {
  queryClient.setQueryData(workspaceKeys.bootstrap("ws_1"), {
    viewerPermissions,
    workspaceSettings: { billingTimezone } as WorkspaceSettings,
  } as unknown as WorkspaceBootstrap)
}

function renderSection(queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>
      <BillingTimezoneSection workspaceId="ws_1" />
    </QueryClientProvider>
  )
}

/**
 * Open the picker and choose a zone. The picker also offers the device zone as a
 * quick-pick row, so a label can appear twice when the runner's own zone is the
 * one being picked; the trailing match is always the list item.
 */
async function pickZone(user: ReturnType<typeof userEvent.setup>, zone: RegExp) {
  await user.click(screen.getByRole("combobox"))
  await user.type(screen.getByPlaceholderText("Search timezone..."), zone.source.replace(/\\/g, ""))
  const matches = await screen.findAllByText(zone)
  await user.click(matches[matches.length - 1])
}

describe("BillingTimezoneSection", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("saves the zone an admin picks", async () => {
    const queryClient = new QueryClient()
    seedBootstrap(queryClient, [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN], "UTC")
    const update = vi
      .spyOn(workspaceSettingsApi, "update")
      .mockResolvedValue({ billingTimezone: "Europe/Stockholm" } as WorkspaceSettings)
    const user = userEvent.setup()

    renderSection(queryClient)
    await pickZone(user, /Europe\/Stockholm/)

    await waitFor(() => expect(update).toHaveBeenCalledWith("ws_1", { billingTimezone: "Europe/Stockholm" }))
  })

  it("reflects an admin's pick immediately, before the save resolves", async () => {
    const queryClient = new QueryClient()
    seedBootstrap(queryClient, [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN], "UTC")
    // Never resolves: the displayed zone must come from the optimistic write,
    // not from the server round-trip.
    vi.spyOn(workspaceSettingsApi, "update").mockReturnValue(new Promise(() => {}))
    const user = userEvent.setup()

    renderSection(queryClient)
    await pickZone(user, /Asia\/Tokyo/)

    await waitFor(() => expect(screen.getByRole("combobox")).toHaveTextContent(/Asia\/Tokyo/))
  })

  it("rolls back to the stored zone when the save fails", async () => {
    const queryClient = new QueryClient()
    seedBootstrap(queryClient, [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN], "UTC")
    const update = vi.spyOn(workspaceSettingsApi, "update").mockRejectedValue(new Error("nope"))
    const user = userEvent.setup()

    renderSection(queryClient)
    await pickZone(user, /Asia\/Tokyo/)

    // Assert the save was actually attempted, else the trailing UTC below would
    // pass just as well for a picker that never fired at all.
    await waitFor(() => expect(update).toHaveBeenCalledWith("ws_1", { billingTimezone: "Asia/Tokyo" }))
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveTextContent(/UTC/))
  })

  it("shows the zone read-only to a non-admin", () => {
    const queryClient = new QueryClient()
    seedBootstrap(queryClient, [], "Europe/Stockholm")

    renderSection(queryClient)

    expect(screen.getByText(/Europe\/Stockholm/)).toBeInTheDocument()
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument()
  })

  it("falls back to the code default when the workspace has stored no zone", () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(workspaceKeys.bootstrap("ws_1"), {
      viewerPermissions: [],
      workspaceSettings: {} as WorkspaceSettings,
    } as unknown as WorkspaceBootstrap)

    renderSection(queryClient)

    expect(screen.getByText(/UTC/)).toBeInTheDocument()
  })
})
