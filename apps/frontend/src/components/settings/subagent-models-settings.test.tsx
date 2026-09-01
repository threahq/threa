import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import type { WorkspaceBootstrap, WorkspaceSettings } from "@threa/types"
import * as contextsModule from "@/contexts"
import { workspaceKeys } from "@/hooks/use-workspaces"
import { PersonalSubagentModelsSection } from "./subagent-models-settings"

const TERRA = "openrouter:openai/gpt-5.6-terra"
const SONNET = "openrouter:anthropic/claude-sonnet-5"

const updatePreference = vi.fn().mockResolvedValue(undefined)

function mockPreferences(subagentModels: string[]) {
  vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
    preferences: { subagentModels },
    updatePreference,
    isLoading: false,
  } as unknown as ReturnType<typeof contextsModule.usePreferences>)
}

function renderSection(workspaceModels: string[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(workspaceKeys.bootstrap("ws_1"), {
    workspaceSettings: { subagentModels: workspaceModels } as WorkspaceSettings,
  } as unknown as WorkspaceBootstrap)
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
  return render(<PersonalSubagentModelsSection workspaceId="ws_1" />, { wrapper: Wrapper })
}

describe("PersonalSubagentModelsSection", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    updatePreference.mockClear()
  })

  it("offers the workspace's models, all ticked, when the user has narrowed nothing", () => {
    mockPreferences([])
    renderSection([TERRA, SONNET])

    expect(screen.getByLabelText("GPT-5.6 Terra")).toHaveAttribute("data-state", "checked")
    expect(screen.getByLabelText("Claude Sonnet 5")).toHaveAttribute("data-state", "checked")
  })

  it("renders nothing when the workspace offers fewer than two models — there is nothing to subset", () => {
    mockPreferences([])
    const { container } = renderSection([TERRA])

    expect(container).toBeEmptyDOMElement()
  })

  it("unticking one stores the rest as the personal subset", async () => {
    mockPreferences([])
    const user = userEvent.setup()
    renderSection([TERRA, SONNET])

    await user.click(screen.getByLabelText("GPT-5.6 Terra"))

    await waitFor(() => expect(updatePreference).toHaveBeenCalledWith("subagentModels", [SONNET]))
  })

  it("ticking the last missing model back stores an empty list, so a widened workspace set still reaches the user", async () => {
    mockPreferences([SONNET])
    const user = userEvent.setup()
    renderSection([TERRA, SONNET])

    await user.click(screen.getByLabelText("GPT-5.6 Terra"))

    await waitFor(() => expect(updatePreference).toHaveBeenCalledWith("subagentModels", []))
  })

  it("will not let the last ticked model be unticked — zero ticks is the follow-the-workspace state", async () => {
    mockPreferences([SONNET])
    const user = userEvent.setup()
    renderSection([TERRA, SONNET])

    const last = screen.getByLabelText("Claude Sonnet 5")
    expect(last).toBeDisabled()
    await user.click(last)

    expect(updatePreference).not.toHaveBeenCalled()
  })

  it("ignores a stored model the workspace has since dropped", () => {
    mockPreferences([SONNET, "openrouter:anthropic/claude-opus-5"])
    renderSection([TERRA, SONNET])

    expect(screen.queryByLabelText("Claude Opus 5")).toBeNull()
    expect(screen.getByLabelText("GPT-5.6 Terra")).toHaveAttribute("data-state", "unchecked")
  })
})
