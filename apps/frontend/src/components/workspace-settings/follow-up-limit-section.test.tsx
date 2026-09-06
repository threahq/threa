import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen, waitFor } from "@testing-library/react"
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

  it("reverts an out-of-range value to the saved value without saving", async () => {
    const queryClient = new QueryClient()
    seedBootstrap(queryClient, [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN], 10)
    const update = vi.spyOn(workspaceSettingsApi, "update")
    const user = userEvent.setup()

    renderSection(queryClient)
    const input = screen.getByLabelText("Assistant follow-ups")
    await user.clear(input)
    await user.type(input, "9999")
    await user.tab()

    expect(update).not.toHaveBeenCalled()
    expect(input).toHaveValue(10)
  })

  it("does not clobber an in-progress edit when a settings broadcast lands", async () => {
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

    // A concurrent admin's save arrives while this field is focused mid-edit;
    // act() flushes the cache-driven re-render so the guard is actually exercised.
    act(() => seedBootstrap(queryClient, [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN], 30))

    // Keystrokes survive the broadcast; blur commits the user's own value.
    expect(input).toHaveValue(25)
    await user.tab()
    await waitFor(() => expect(update).toHaveBeenCalledWith("ws_1", { maxPendingFollowUps: 25 }))
  })

  it("reflects a broadcast on a focused-but-unedited field without saving the stale value", async () => {
    const queryClient = new QueryClient()
    seedBootstrap(queryClient, [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN], 10)
    const update = vi.spyOn(workspaceSettingsApi, "update")
    const user = userEvent.setup()

    renderSection(queryClient)
    const input = screen.getByLabelText("Assistant follow-ups")
    await user.click(input) // focus, no keystrokes

    // Another admin's save lands while the field is merely focused. An unedited
    // field reflects the new value (a focus-only guard would freeze it at 10).
    seedBootstrap(queryClient, [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN], 30)
    await waitFor(() => expect(input).toHaveValue(30))

    await user.tab()
    // Blurring an untouched field must not stomp the concurrent change back to 10.
    expect(update).not.toHaveBeenCalled()
    expect(input).toHaveValue(30)
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
