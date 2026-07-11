import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { forwardRef, useImperativeHandle } from "react"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { JSONContent, PersonaConfigResponse, PersonaResolvedConfig } from "@threa/types"
import { personasApi } from "@/api"
import { ApiError } from "@/api/client"
import { spyOnExport } from "@/test/spy"
import * as editorModule from "@/components/editor"
import { PersonaEditorForm } from "./persona-editor-form"

function extractText(node: JSONContent | undefined): string {
  if (!node) return ""
  if (node.type === "text") return node.text ?? ""
  return (node.content ?? []).map((child) => extractText(child)).join("")
}

function createDoc(text: string): JSONContent {
  return { type: "doc", content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : undefined }] }
}

// The system-prompt field mounts a RichEditor; stub it as a plain textarea (the
// established pattern in ai-settings.test) so tests exercise the markdown
// round-trip and per-field reset without a real TipTap instance in jsdom.
beforeEach(() => {
  const MockRichEditor = forwardRef<
    {
      focus: () => void
      insertMention: () => void
      insertSlash: () => void
      insertEmoji: () => void
      getEditor: () => null
    },
    { value: JSONContent; onChange: (v: JSONContent) => void; onSubmit?: () => void; ariaLabel?: string }
  >(function MockRichEditor({ value, onChange, onSubmit, ariaLabel }, ref) {
    useImperativeHandle(ref, () => ({
      focus: () => undefined,
      insertMention: () => undefined,
      insertSlash: () => undefined,
      insertEmoji: () => undefined,
      getEditor: () => null,
    }))
    return (
      <textarea
        aria-label={ariaLabel}
        value={extractText(value)}
        onChange={(event) => onChange(createDoc(event.target.value))}
        onKeyDown={(event) => {
          if (event.key === "Enter" && event.metaKey) {
            event.preventDefault()
            onSubmit?.()
          }
        }}
      />
    )
  })
  spyOnExport(editorModule, "RichEditor").mockReturnValue(MockRichEditor as unknown as typeof editorModule.RichEditor)

  const MockEditorActionBar = (({ trailingContent }: Record<string, unknown>) => (
    <div>{trailingContent as React.ReactNode}</div>
  )) as unknown as typeof editorModule.EditorActionBar
  spyOnExport(editorModule, "EditorActionBar").mockReturnValue(MockEditorActionBar)
})

afterEach(() => vi.restoreAllMocks())

function defaults(): PersonaResolvedConfig {
  return {
    id: "persona_system_ariadne",
    workspaceId: null,
    slug: "ariadne",
    name: "Ariadne",
    description: "Your AI thinking companion.",
    avatarEmoji: ":thread:",
    systemPrompt: "You are Ariadne.",
    model: "openrouter:anthropic/claude-sonnet-4.6",
    escalationModel: "openrouter:anthropic/claude-opus-4.8",
    temperature: 0.7,
    maxTokens: null,
    enabledTools: ["send_message", "web_search"],
    managedBy: "system",
    status: "active",
    visibility: "visible",
    e2eCapable: true,
  }
}

function config(overrides: Partial<PersonaConfigResponse> = {}): PersonaConfigResponse {
  const d = defaults()
  return {
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

describe("PersonaEditorForm", () => {
  it("saves only the fields that diverge from defaults (sparse patch)", async () => {
    const put = vi
      .spyOn(personasApi, "putOverride")
      .mockResolvedValue({ persona: { id: "persona_system_ariadne" } as never, updatedAt: "2026-07-11T00:00:00Z" })
    const user = userEvent.setup()
    renderForm()

    const name = screen.getByLabelText("Name")
    await user.clear(name)
    await user.type(name, "Ari")
    await user.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() =>
      expect(put).toHaveBeenCalledWith("ws_1", "persona_system_ariadne", {
        patch: { name: "Ari" },
        expectedUpdatedAt: null,
      })
    )
  })

  it("resets a field back to its default, clearing the pending change", async () => {
    const user = userEvent.setup()
    renderForm()

    const name = screen.getByLabelText("Name")
    await user.clear(name)
    await user.type(name, "Ari")
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled()

    // Name is the first field; its reset control is the first "Reset" button.
    await user.click(screen.getAllByRole("button", { name: "Reset" })[0])

    expect(screen.getByLabelText("Name")).toHaveValue("Ariadne")
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
  })

  it("surfaces a concurrent edit inline and keeps the local draft (INV-63)", async () => {
    vi.spyOn(personasApi, "putOverride").mockRejectedValue(
      new ApiError(409, "PERSONA_OVERRIDE_CONFLICT", "conflict", {
        current: { patch: { name: "Theirs" }, updatedAt: "2026-07-11T01:00:00Z" },
      })
    )
    const user = userEvent.setup()
    renderForm()

    const name = screen.getByLabelText("Name")
    await user.clear(name)
    await user.type(name, "Mine")
    await user.click(screen.getByRole("button", { name: "Save" }))

    expect(await screen.findByText(/Someone else updated this persona/)).toBeInTheDocument()
    expect(screen.getByLabelText("Name")).toHaveValue("Mine")
  })

  it("adopts a concurrent override that arrives via broadcast when the form is pristine (no silent clobber)", async () => {
    const put = vi
      .spyOn(personasApi, "putOverride")
      .mockResolvedValue({ persona: { id: "persona_system_ariadne" } as never, updatedAt: "2026-07-11T03:00:00Z" })
    const { rerenderWith } = renderForm()

    // Another admin's commit lands via `agent_config:updated` → the config query
    // refetches and the parent re-renders this form with the advanced baseline.
    rerenderWith(
      config({
        overridePatch: { name: "Theirs" },
        overrideUpdatedAt: "2026-07-11T02:00:00Z",
        resolved: { ...defaults(), name: "Theirs" },
      })
    )

    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue("Theirs"))
    // The form has no unsynced work, so it adopts their version and Save stays
    // disabled — the old bug armed Save under stale values and wrote an empty patch.
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
    expect(put).not.toHaveBeenCalled()
  })

  it("surfaces a conflict instead of clobbering when a concurrent override arrives mid-edit (INV-63)", async () => {
    const user = userEvent.setup()
    const { rerenderWith } = renderForm()

    const name = screen.getByLabelText("Name")
    await user.clear(name)
    await user.type(name, "Mine")

    rerenderWith(
      config({
        overridePatch: { name: "Theirs" },
        overrideUpdatedAt: "2026-07-11T02:00:00Z",
        resolved: { ...defaults(), name: "Theirs" },
      })
    )

    expect(await screen.findByText(/Someone else updated this persona/)).toBeInTheDocument()
    expect(screen.getByLabelText("Name")).toHaveValue("Mine")
  })

  it("saves a system-prompt edit as serialized markdown in the sparse patch", async () => {
    const put = vi
      .spyOn(personasApi, "putOverride")
      .mockResolvedValue({ persona: { id: "persona_system_ariadne" } as never, updatedAt: "2026-07-11T00:00:00Z" })
    const user = userEvent.setup()
    renderForm()

    const prompt = screen.getByLabelText("Persona system prompt editor")
    await user.clear(prompt)
    await user.type(prompt, "Be terse.")
    await user.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() =>
      expect(put).toHaveBeenCalledWith("ws_1", "persona_system_ariadne", {
        patch: { systemPrompt: "Be terse." },
        expectedUpdatedAt: null,
      })
    )
  })

  it("resets the system prompt back to its default, clearing the pending change", async () => {
    const user = userEvent.setup()
    renderForm()

    const prompt = screen.getByLabelText("Persona system prompt editor")
    await user.clear(prompt)
    await user.type(prompt, "Draft prompt")
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled()

    // System prompt is the fourth field (Name, Description, Avatar, System prompt).
    await user.click(screen.getAllByRole("button", { name: "Reset" })[3])

    expect(screen.getByLabelText("Persona system prompt editor")).toHaveValue("You are Ariadne.")
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
  })

  it("debounces edits into a draft write", async () => {
    const putDraft = vi
      .spyOn(personasApi, "putDraft")
      .mockResolvedValue({ patch: { name: "Ari" }, testStreamId: null, updatedAt: "2026-07-11T00:00:00Z" })
    const user = userEvent.setup()
    renderForm()

    const name = screen.getByLabelText("Name")
    await user.clear(name)
    await user.type(name, "Ari")

    await waitFor(() => expect(putDraft).toHaveBeenCalledWith("ws_1", "persona_system_ariadne", { name: "Ari" }), {
      timeout: 2000,
    })
  })
})
