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
import { DictationTab } from "./dictation-tab"

function seedBootstrap(
  queryClient: QueryClient,
  viewerPermissions: WorkspacePermissionSlug[],
  voiceSteeringWords: string[]
) {
  queryClient.setQueryData(workspaceKeys.bootstrap("ws_1"), {
    viewerPermissions,
    workspaceSettings: { voiceSteeringWords } as WorkspaceSettings,
  } as unknown as WorkspaceBootstrap)
}

function renderTab(queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>
      <DictationTab workspaceId="ws_1" />
    </QueryClientProvider>
  )
}

describe("DictationTab", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("lets an admin add a shared steering word", async () => {
    const queryClient = new QueryClient()
    seedBootstrap(queryClient, [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN], [])
    const update = vi
      .spyOn(workspaceSettingsApi, "update")
      .mockResolvedValue({ voiceSteeringWords: ["Acme"] } as WorkspaceSettings)
    const user = userEvent.setup()

    renderTab(queryClient)
    await user.type(screen.getByLabelText("Add a dictation steering word"), "Acme{Enter}")

    await waitFor(() => expect(update).toHaveBeenCalledWith("ws_1", { voiceSteeringWords: ["Acme"] }))
  })

  it("shows the list read-only to a non-admin", () => {
    const queryClient = new QueryClient()
    seedBootstrap(queryClient, [], ["Shared"])

    renderTab(queryClient)

    expect(screen.getByText("Shared")).toBeInTheDocument()
    // No editing affordances for a non-admin.
    expect(screen.queryByLabelText("Add a dictation steering word")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Remove Shared" })).not.toBeInTheDocument()
    expect(screen.getByText(/Only workspace admins can change/i)).toBeInTheDocument()
  })
})
