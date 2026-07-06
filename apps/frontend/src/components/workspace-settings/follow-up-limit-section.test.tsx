import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  WORKSPACE_PERMISSION_SCOPES,
  type WorkspaceBootstrap,
  type WorkspaceSettings,
  type WorkspacePermissionSlug,
} from "@threa/types"
import { workspaceKeys } from "@/hooks/use-workspaces"
import { workspaceSettingsApi } from "@/api"
import { FollowUpLimitSection } from "./follow-up-limit-section"

function seedBootstrap(
  queryClient: QueryClient,
  viewerPermissions: WorkspacePermissionSlug[],
  maxPendingFollowUps: number
) {
  queryClient.setQueryData(workspaceKeys.bootstrap("ws_1"), {
    viewerPermissions,
    workspaceSettings: { maxPendingFollowUps } as WorkspaceSettings,
  } as unknown as WorkspaceBootstrap)
}

function renderSection(queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>
      <FollowUpLimitSection workspaceId="ws_1" />
    </QueryClientProvider>
  )
}

describe("FollowUpLimitSection", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("saves a raised limit on blur when an admin edits it", async () => {
    const queryClient = new QueryClient()
    seedBootstrap(queryClient, [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN], 10)
    const update = vi
      .spyOn(workspaceSettingsApi, "update")
      .mockResolvedValue({ maxPendingFollowUps: 25 } as WorkspaceSettings)
    const user = userEvent.setup()

    renderSection(queryClient)
    const input = screen.getByLabelText("Assistant follow-ups")
    await user.clear(input)
    await user.type(input, "25")
    await user.tab()

    await waitFor(() => expect(update).toHaveBeenCalledWith("ws_1", { maxPendingFollowUps: 25 }))
  })

  it("clamps an out-of-range value before saving", async () => {
    const queryClient = new QueryClient()
    seedBootstrap(queryClient, [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN], 10)
    const update = vi
      .spyOn(workspaceSettingsApi, "update")
      .mockResolvedValue({ maxPendingFollowUps: 100 } as WorkspaceSettings)
    const user = userEvent.setup()

    renderSection(queryClient)
    const input = screen.getByLabelText("Assistant follow-ups")
    await user.clear(input)
    await user.type(input, "9999")
    await user.tab()

    await waitFor(() => expect(update).toHaveBeenCalledWith("ws_1", { maxPendingFollowUps: 100 }))
  })

  it("does not save when the value is unchanged", async () => {
    const queryClient = new QueryClient()
    seedBootstrap(queryClient, [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN], 10)
    const update = vi.spyOn(workspaceSettingsApi, "update")
    const user = userEvent.setup()

    renderSection(queryClient)
    const input = screen.getByLabelText("Assistant follow-ups")
    await user.click(input)
    await user.tab()

    expect(update).not.toHaveBeenCalled()
  })

  it("shows the value read-only to a non-admin", () => {
    const queryClient = new QueryClient()
    seedBootstrap(queryClient, [], 15)

    renderSection(queryClient)

    expect(screen.getByText("15")).toBeInTheDocument()
    expect(screen.queryByLabelText("Assistant follow-ups")).not.toBeInTheDocument()
  })
})
