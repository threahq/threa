import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import {
  DEFAULT_SUBAGENT_MODELS,
  SUBAGENT_MODEL_CATALOG,
  type WorkspaceBootstrap,
  type WorkspaceSettings,
} from "@threa/types"
import * as contextsModule from "@/contexts"
import { workspaceKeys } from "@/hooks/use-workspaces"
import { PersonalSubagentModelsSection } from "./subagent-models-settings"

const TERRA = "openrouter:openai/gpt-5.6-terra"
const SONNET = "openrouter:anthropic/claude-sonnet-5"
const OPUS = "openrouter:anthropic/claude-opus-5"

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
    expect(screen.getByText(/Following your workspace's set/)).toBeInTheDocument()
  })

  it("renders nothing when the workspace offers fewer than two models — there is nothing to subset", () => {
    mockPreferences([])
    const { container } = renderSection([TERRA])

    expect(container).toBeEmptyDOMElement()
  })

  it("stays visible for a one-model workspace when a stale subset turned delegation off, and re-picking recovers", async () => {
    mockPreferences([OPUS])
    const user = userEvent.setup()
    renderSection([TERRA])

    expect(screen.getByText(/nothing can be delegated for you/)).toBeInTheDocument()

    await user.click(screen.getByLabelText("GPT-5.6 Terra"))

    // The full workspace set elides the override, so the stale pin is cleared.
    await waitFor(() => expect(updatePreference).toHaveBeenCalledWith("subagentModels", []))
  })

  it("renders nothing for an empty workspace set even with a stale subset — delegation is off workspace-wide", () => {
    mockPreferences([OPUS])
    const { container } = renderSection([])

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

  it("unticking the last one stores an empty list — that is the follow-the-workspace state", async () => {
    mockPreferences([SONNET])
    const user = userEvent.setup()
    renderSection([TERRA, SONNET])

    await user.click(screen.getByLabelText("Claude Sonnet 5"))

    await waitFor(() => expect(updatePreference).toHaveBeenCalledWith("subagentModels", []))
  })

  it("drops a stored model the workspace no longer offers on the next edit", async () => {
    mockPreferences([SONNET, OPUS])
    const user = userEvent.setup()
    renderSection([TERRA, SONNET])

    expect(screen.queryByLabelText("Claude Opus 5")).toBeNull()
    expect(screen.getByLabelText("GPT-5.6 Terra")).toHaveAttribute("data-state", "unchecked")

    await user.click(screen.getByLabelText("GPT-5.6 Terra"))

    await waitFor(() => expect(updatePreference).toHaveBeenCalledWith("subagentModels", []))
  })

  it("says delegation is off when the stored subset no longer names a workspace model", () => {
    mockPreferences([OPUS])
    renderSection([TERRA, SONNET])

    // Ticks come from the STORED preference, so nothing is ticked — the picker
    // must not claim the full set the user does not actually have.
    expect(screen.getByLabelText("GPT-5.6 Terra")).toHaveAttribute("data-state", "unchecked")
    expect(screen.getByLabelText("Claude Sonnet 5")).toHaveAttribute("data-state", "unchecked")
    expect(screen.getByText(/nothing can be delegated for you/)).toBeInTheDocument()
    expect(screen.queryByText(/Following your workspace's set/)).toBeNull()
  })

  it("re-picking from the emptied state stores just that model", async () => {
    mockPreferences([OPUS])
    const user = userEvent.setup()
    renderSection([TERRA, SONNET])

    await user.click(screen.getByLabelText("GPT-5.6 Terra"))

    await waitFor(() => expect(updatePreference).toHaveBeenCalledWith("subagentModels", [TERRA]))
  })

  it("falls back to the shipped default set and stays read-only while the bootstrap is unresolved", () => {
    mockPreferences([])
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    }
    render(<PersonalSubagentModelsSection workspaceId="ws_1" />, { wrapper: Wrapper })

    for (const modelId of DEFAULT_SUBAGENT_MODELS) {
      const box = screen.getByLabelText(SUBAGENT_MODEL_CATALOG.find((entry) => entry.id === modelId)!.label)
      expect(box).toHaveAttribute("data-state", "checked")
      expect(box).toBeDisabled()
    }
  })

  it("makes no claim about the user's subset while the bootstrap is unresolved", () => {
    // Opus is opt-in, so it is outside the shipped default the mid-load render
    // stands in with; the amber "nothing can be delegated" line must wait for
    // the workspace's real set rather than flash against the placeholder.
    mockPreferences([OPUS])
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    }
    render(<PersonalSubagentModelsSection workspaceId="ws_1" />, { wrapper: Wrapper })

    expect(screen.queryByText(/nothing can be delegated for you/)).not.toBeInTheDocument()
  })
})
