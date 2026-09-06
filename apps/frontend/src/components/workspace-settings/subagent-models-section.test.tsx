import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  DEFAULT_SUBAGENT_MODELS,
  SUBAGENT_MODEL_CATALOG,
  WORKSPACE_PERMISSION_SCOPES,
  type WorkspaceBootstrap,
  type WorkspacePermissionSlug,
  type WorkspaceSettings,
} from "@threahq/types"
import { workspaceKeys } from "@/hooks/use-workspaces"
import { workspaceSettingsApi } from "@/api"
import { SubagentModelsSection } from "./subagent-models-section"

const PREMIUM = SUBAGENT_MODEL_CATALOG.find((entry) => entry.tier === "premium")!

function seedBootstrap(
  queryClient: QueryClient,
  viewerPermissions: WorkspacePermissionSlug[],
  subagentModels: string[]
) {
  queryClient.setQueryData(workspaceKeys.bootstrap("ws_1"), {
    viewerPermissions,
    workspaceSettings: { subagentModels } as WorkspaceSettings,
  } as unknown as WorkspaceBootstrap)
}

function renderSection(queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>
      <SubagentModelsSection workspaceId="ws_1" />
    </QueryClientProvider>
  )
}

describe("SubagentModelsSection", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("shows every catalog model with its rates and marks the premium tier opt-in", () => {
    const queryClient = new QueryClient()
    seedBootstrap(queryClient, [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN], DEFAULT_SUBAGENT_MODELS)

    renderSection(queryClient)

    for (const entry of SUBAGENT_MODEL_CATALOG) {
      expect(screen.getByLabelText(new RegExp(entry.label))).toBeInTheDocument()
    }
    expect(screen.getByText(/\$2\.50 in · \$15\.00 out per 1M tokens/)).toBeInTheDocument()
    expect(screen.getAllByText("Premium").length).toBe(
      SUBAGENT_MODEL_CATALOG.filter((entry) => entry.tier === "premium").length
    )
  })

  it("ticks exactly the workspace's stored set", () => {
    const queryClient = new QueryClient()
    seedBootstrap(queryClient, [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN], DEFAULT_SUBAGENT_MODELS)

    renderSection(queryClient)

    for (const entry of SUBAGENT_MODEL_CATALOG) {
      expect(screen.getByLabelText(new RegExp(entry.label))).toHaveAttribute(
        "data-state",
        DEFAULT_SUBAGENT_MODELS.includes(entry.id) ? "checked" : "unchecked"
      )
    }
  })

  it("adding a premium model saves the whole list with it appended", async () => {
    const queryClient = new QueryClient()
    seedBootstrap(queryClient, [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN], DEFAULT_SUBAGENT_MODELS)
    const update = vi
      .spyOn(workspaceSettingsApi, "update")
      .mockResolvedValue({ subagentModels: [...DEFAULT_SUBAGENT_MODELS, PREMIUM.id] } as WorkspaceSettings)
    const user = userEvent.setup()

    renderSection(queryClient)
    await user.click(screen.getByLabelText(new RegExp(PREMIUM.label)))

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith("ws_1", { subagentModels: [...DEFAULT_SUBAGENT_MODELS, PREMIUM.id] })
    )
  })

  it("unticking a model saves the list without it", async () => {
    const queryClient = new QueryClient()
    seedBootstrap(queryClient, [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN], DEFAULT_SUBAGENT_MODELS)
    const update = vi
      .spyOn(workspaceSettingsApi, "update")
      .mockResolvedValue({ subagentModels: [DEFAULT_SUBAGENT_MODELS[1]] } as WorkspaceSettings)
    const user = userEvent.setup()

    renderSection(queryClient)
    const first = SUBAGENT_MODEL_CATALOG.find((entry) => entry.id === DEFAULT_SUBAGENT_MODELS[0])!
    await user.click(screen.getByLabelText(new RegExp(first.label)))

    await waitFor(() => expect(update).toHaveBeenCalledWith("ws_1", { subagentModels: [DEFAULT_SUBAGENT_MODELS[1]] }))
  })

  it("a non-admin sees the set but cannot change it", async () => {
    const queryClient = new QueryClient()
    seedBootstrap(queryClient, [], DEFAULT_SUBAGENT_MODELS)
    const update = vi.spyOn(workspaceSettingsApi, "update")
    const user = userEvent.setup()

    renderSection(queryClient)
    const checkbox = screen.getByLabelText(new RegExp(PREMIUM.label))
    expect(checkbox).toBeDisabled()
    await user.click(checkbox)

    expect(update).not.toHaveBeenCalled()
  })

  it("round-trips an untick and retick to the canonical order, so the default elides again", async () => {
    const queryClient = new QueryClient()
    // Stored in an order no admin would have arranged by hand — the shape a
    // naive append leaves behind, and the one that stops the default eliding.
    seedBootstrap(queryClient, [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN], [DEFAULT_SUBAGENT_MODELS[1]])
    const update = vi
      .spyOn(workspaceSettingsApi, "update")
      .mockResolvedValue({ subagentModels: DEFAULT_SUBAGENT_MODELS } as WorkspaceSettings)
    const user = userEvent.setup()

    renderSection(queryClient)
    const first = SUBAGENT_MODEL_CATALOG.find((entry) => entry.id === DEFAULT_SUBAGENT_MODELS[0])!
    await user.click(screen.getByLabelText(new RegExp(first.label)))

    await waitFor(() => expect(update).toHaveBeenCalledWith("ws_1", { subagentModels: DEFAULT_SUBAGENT_MODELS }))
  })

  it("falls back to the shipped default set while the bootstrap is unresolved, and claims nothing", () => {
    const queryClient = new QueryClient()
    renderSection(queryClient)

    for (const entry of SUBAGENT_MODEL_CATALOG) {
      const box = screen.getByLabelText(new RegExp(entry.label))
      expect(box).toHaveAttribute("data-state", DEFAULT_SUBAGENT_MODELS.includes(entry.id) ? "checked" : "unchecked")
      expect(box).toBeDisabled()
    }
    expect(screen.queryByText(/assistants cannot delegate/)).toBeNull()
  })

  it("says so once an empty set is genuinely what the workspace stored", () => {
    const queryClient = new QueryClient()
    seedBootstrap(queryClient, [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN], [])

    renderSection(queryClient)

    expect(screen.getByText(/assistants cannot delegate/)).toBeInTheDocument()
  })

  it("keeps a stored model the catalog no longer lists tickable, so it can be dropped", async () => {
    const queryClient = new QueryClient()
    const retired = "openrouter:anthropic/claude-sonnet-4.6"
    seedBootstrap(queryClient, [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN], [...DEFAULT_SUBAGENT_MODELS, retired])
    const update = vi
      .spyOn(workspaceSettingsApi, "update")
      .mockResolvedValue({ subagentModels: DEFAULT_SUBAGENT_MODELS } as WorkspaceSettings)
    const user = userEvent.setup()

    renderSection(queryClient)
    await user.click(screen.getByLabelText(/Claude Sonnet 4.6/))

    await waitFor(() => expect(update).toHaveBeenCalledWith("ws_1", { subagentModels: DEFAULT_SUBAGENT_MODELS }))
  })
})
