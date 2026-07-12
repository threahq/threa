import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PersonaConfigResponse, PersonaResolvedConfig } from "@threa/types"
import { personasApi } from "@/api"
import { ApiError } from "@/api/client"
import { PersonaEditorForm } from "./persona-editor-form"

afterEach(() => vi.restoreAllMocks())

function defaults(): PersonaResolvedConfig {
  return {
    id: "persona_system_ariadne",
    workspaceId: null,
    slug: "ariadne",
    name: "Ariadne",
    description: "Your AI thinking companion.",
    avatarEmoji: ":thread:",
    avatarUrl: null,
    systemPrompt: "You are Ariadne.",
    model: "openrouter:anthropic/claude-sonnet-4.6",
    escalationModel: "openrouter:anthropic/claude-opus-4.8",
    temperature: 0.7,
    maxTokens: null,
    enabledTools: ["send_message", "web_search"],
    tonePreset: null,
    brevityPreset: null,
    tonePrompt: null,
    brevityPrompt: null,
    managedBy: "system",
    status: "active",
    visibility: "visible",
    e2eCapable: true,
  }
}

function config(overrides: Partial<PersonaConfigResponse> = {}): PersonaConfigResponse {
  const d = defaults()
  return {
    kind: "builtin",
    defaults: d,
    overridePatch: null,
    overrideUpdatedAt: null,
    resolved: d,
    draft: null,
    availableModels: [
      { id: "openrouter:anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6" },
      { id: "openrouter:anthropic/claude-opus-4.8", label: "Claude Opus 4.8" },
    ],
    ...overrides,
  }
}

function renderForm(cfg: PersonaConfigResponse = config()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <PersonaEditorForm workspaceId="ws_1" personaId="persona_system_ariadne" config={cfg} />
    </QueryClientProvider>
  )
  const rerenderWith = (next: PersonaConfigResponse) =>
    utils.rerender(
      <QueryClientProvider client={queryClient}>
        <PersonaEditorForm workspaceId="ws_1" personaId="persona_system_ariadne" config={next} />
      </QueryClientProvider>
    )
  return { ...utils, rerenderWith }
}

describe("PersonaEditorForm (restricted built-in editor)", () => {
  it("offers only the editable fields — no locked identity/prompt inputs; the prompt is read-only", async () => {
    const user = userEvent.setup()
    renderForm()

    // Editable fields present.
    expect(screen.getByText("Model")).toBeInTheDocument()
    expect(screen.getByText("Tone")).toBeInTheDocument()
    expect(screen.getByText("Brevity")).toBeInTheDocument()
    expect(screen.getByText("Tools")).toBeInTheDocument()

    // Locked identity/prompt inputs are absent.
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument()
    expect(screen.queryByLabelText("Persona system prompt editor")).not.toBeInTheDocument()

    // The system prompt is shown read-only inside a disclosure.
    await user.click(screen.getByRole("button", { name: /System prompt/ }))
    expect(await screen.findByText("You are Ariadne.")).toBeInTheDocument()
  })

  it("saves a sparse patch containing only editable keys", async () => {
    const put = vi
      .spyOn(personasApi, "putOverride")
      .mockResolvedValue({ persona: { id: "persona_system_ariadne" } as never, updatedAt: "2026-07-11T00:00:00Z" })
    const user = userEvent.setup()
    renderForm()

    // Toggle a tool off — the only thing that changed.
    await user.click(screen.getByRole("checkbox", { name: "Web search" }))
    await user.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() =>
      expect(put).toHaveBeenCalledWith("ws_1", "persona_system_ariadne", {
        patch: { enabledTools: ["send_message"] },
        expectedUpdatedAt: null,
      })
    )
  })

  it("commits a style-preset draft as a tonePreset patch (an allowed key)", async () => {
    const put = vi
      .spyOn(personasApi, "putOverride")
      .mockResolvedValue({ persona: { id: "persona_system_ariadne" } as never, updatedAt: "2026-07-11T00:00:00Z" })
    const user = userEvent.setup()
    // A saved draft that set the tone preset seeds the form dirty.
    renderForm(
      config({ draft: { patch: { tonePreset: "direct" }, testStreamId: null, updatedAt: "2026-07-11T00:00:00Z" } })
    )

    await user.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() =>
      expect(put).toHaveBeenCalledWith("ws_1", "persona_system_ariadne", {
        patch: { tonePreset: "direct" },
        expectedUpdatedAt: null,
      })
    )
  })

  it("surfaces a concurrent edit inline and keeps the local draft (INV-63)", async () => {
    vi.spyOn(personasApi, "putOverride").mockRejectedValue(
      new ApiError(409, "PERSONA_OVERRIDE_CONFLICT", "conflict", {
        current: { patch: { model: "openrouter:anthropic/claude-opus-4.8" }, updatedAt: "2026-07-11T01:00:00Z" },
      })
    )
    const user = userEvent.setup()
    renderForm()

    await user.click(screen.getByRole("checkbox", { name: "Web search" }))
    await user.click(screen.getByRole("button", { name: "Save" }))

    expect(await screen.findByText(/Someone else updated this persona/)).toBeInTheDocument()
    // Local edit kept — the tool is still unchecked.
    expect(screen.getByRole("checkbox", { name: "Web search" })).not.toBeChecked()
  })

  it("adopts a concurrent override that arrives via broadcast when pristine (no silent clobber)", async () => {
    const put = vi
      .spyOn(personasApi, "putOverride")
      .mockResolvedValue({ persona: { id: "persona_system_ariadne" } as never, updatedAt: "2026-07-11T03:00:00Z" })
    const { rerenderWith } = renderForm()

    // Initially the model trigger shows the default.
    expect(screen.getByText("Claude Sonnet 4.6")).toBeInTheDocument()

    rerenderWith(
      config({
        overridePatch: { model: "openrouter:anthropic/claude-opus-4.8" },
        overrideUpdatedAt: "2026-07-11T02:00:00Z",
        resolved: { ...defaults(), model: "openrouter:anthropic/claude-opus-4.8" },
      })
    )

    // Pristine form adopts their model; Save stays disabled and never fires.
    await waitFor(() => expect(screen.getByText("Claude Opus 4.8")).toBeInTheDocument())
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
    expect(put).not.toHaveBeenCalled()
  })

  it("surfaces a conflict instead of clobbering when a concurrent override arrives mid-edit (INV-63)", async () => {
    const user = userEvent.setup()
    const { rerenderWith } = renderForm()

    await user.click(screen.getByRole("checkbox", { name: "Web search" }))

    rerenderWith(
      config({
        overridePatch: { model: "openrouter:anthropic/claude-opus-4.8" },
        overrideUpdatedAt: "2026-07-11T02:00:00Z",
        resolved: { ...defaults(), model: "openrouter:anthropic/claude-opus-4.8" },
      })
    )

    expect(await screen.findByText(/Someone else updated this persona/)).toBeInTheDocument()
    expect(screen.getByRole("checkbox", { name: "Web search" })).not.toBeChecked()
  })

  it("debounces edits into a draft write", async () => {
    const putDraft = vi
      .spyOn(personasApi, "putDraft")
      .mockResolvedValue({
        patch: { enabledTools: ["send_message"] },
        testStreamId: null,
        updatedAt: "2026-07-11T00:00:00Z",
      })
    const user = userEvent.setup()
    renderForm()

    await user.click(screen.getByRole("checkbox", { name: "Web search" }))

    await waitFor(
      () => expect(putDraft).toHaveBeenCalledWith("ws_1", "persona_system_ariadne", { enabledTools: ["send_message"] }),
      { timeout: 2000 }
    )
  })

  it("a pending debounce does not resurrect the draft after Save (ghost-draft regression)", async () => {
    const putDraft = vi
      .spyOn(personasApi, "putDraft")
      .mockResolvedValue({
        patch: { enabledTools: ["send_message"] },
        testStreamId: null,
        updatedAt: "2026-07-11T00:00:00Z",
      })
    const putOverride = vi
      .spyOn(personasApi, "putOverride")
      .mockResolvedValue({ persona: { id: "persona_system_ariadne" }, updatedAt: "2026-07-11T00:00:01Z" } as never)
    const user = userEvent.setup()
    renderForm()

    await user.click(screen.getByRole("checkbox", { name: "Web search" }))
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(putOverride).toHaveBeenCalled())

    await new Promise((resolve) => setTimeout(resolve, 900))
    expect(putDraft).not.toHaveBeenCalled()
  })
})
