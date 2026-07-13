import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { forwardRef, useImperativeHandle } from "react"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { toast } from "sonner"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PersonaAttachmentItem, JSONContent, PersonaConfigResponse, PersonaResolvedConfig } from "@threa/types"
import { personasApi } from "@/api"
import { ApiError } from "@/api/client"
import { spyOnExport } from "@/test/spy"
import * as editorModule from "@/components/editor"
import { CustomPersonaEditor } from "./custom-persona-editor"

function extractText(node: JSONContent | undefined): string {
  if (!node) return ""
  if (node.type === "text") return node.text ?? ""
  return (node.content ?? []).map((child) => extractText(child)).join("")
}
function createDoc(text: string): JSONContent {
  return { type: "doc", content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : undefined }] }
}

beforeEach(() => {
  const MockRichEditor = forwardRef<
    {
      focus: () => void
      insertMention: () => void
      insertSlash: () => void
      insertEmoji: () => void
      getEditor: () => null
    },
    { value: JSONContent; onChange: (v: JSONContent) => void; ariaLabel?: string }
  >(function MockRichEditor({ value, onChange, ariaLabel }, ref) {
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
        onChange={(e) => onChange(createDoc(e.target.value))}
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

function resolved(): PersonaResolvedConfig {
  return {
    id: "persona_c1",
    workspaceId: "ws_1",
    slug: "researcher",
    name: "Researcher",
    description: "Digs.",
    avatarEmoji: null,
    avatarUrl: null,
    systemPrompt: "You research.",
    model: "openrouter:anthropic/claude-sonnet-4.6",
    escalationModel: null,
    temperature: 0.7,
    maxTokens: null,
    enabledTools: ["send_message"],
    tonePreset: null,
    brevityPreset: null,
    tonePrompt: null,
    brevityPrompt: null,
    managedBy: "workspace",
    status: "active",
    visibility: "visible",
    e2eCapable: false,
  }
}

function config(overrides: Partial<PersonaConfigResponse> = {}): PersonaConfigResponse {
  return {
    kind: "custom",
    defaults: null,
    overridePatch: null,
    overrideUpdatedAt: "2026-07-12T00:00:00Z",
    resolved: resolved(),
    draft: null,
    attachments: [],
    availableModels: [{ id: "openrouter:anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6" }],
    ...overrides,
  }
}

function attachment(overrides: Partial<PersonaAttachmentItem> = {}): PersonaAttachmentItem {
  return {
    id: "att_1",
    filename: "handbook.pdf",
    mimeType: "application/pdf",
    sizeBytes: 12 * 1024,
    processingStatus: "ready",
    position: 0,
    createdAt: "2026-07-12T00:00:00Z",
    ...overrides,
  }
}

/** The hidden knowledge file input, distinguished from the avatar input by its mime accept. */
function attachmentInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="file"][accept*="application/pdf"]')
  if (!input) throw new Error("attachment file input not found")
  return input
}

function renderEditor(cfg: PersonaConfigResponse = config()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const tree = (next: PersonaConfigResponse) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/w/ws_1/settings/personas/persona_c1"]}>
        <Routes>
          <Route
            path="/w/:workspaceId/settings/personas/:personaId"
            element={<CustomPersonaEditor workspaceId="ws_1" personaId="persona_c1" config={next} />}
          />
          <Route path="/w/:workspaceId" element={<div>Workspace home</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
  const result = render(tree(cfg))
  return { ...result, rerenderConfig: (next: PersonaConfigResponse) => result.rerender(tree(next)) }
}

describe("CustomPersonaEditor", () => {
  it("saves the full config verbatim with the row's OCC token", async () => {
    const update = vi
      .spyOn(personasApi, "updateCustom")
      .mockResolvedValue({ persona: { id: "persona_c1" } as never, updatedAt: "2026-07-12T01:00:00Z" })
    const user = userEvent.setup()
    renderEditor()

    const name = screen.getByLabelText("Name")
    await user.clear(name)
    await user.type(name, "Research Bot")
    await user.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith("ws_1", "persona_c1", {
        config: {
          name: "Research Bot",
          description: "Digs.",
          avatarEmoji: null,
          systemPrompt: "You research.",
          model: "openrouter:anthropic/claude-sonnet-4.6",
          escalationModel: null,
          temperature: 0.7,
          maxTokens: null,
          enabledTools: ["send_message"],
          tonePrompt: null,
          brevityPrompt: null,
        },
        expectedUpdatedAt: "2026-07-12T00:00:00Z",
      })
    )
  })

  it("surfaces a concurrent edit inline and keeps local edits (INV-63)", async () => {
    vi.spyOn(personasApi, "updateCustom").mockRejectedValue(
      new ApiError(409, "PERSONA_OVERRIDE_CONFLICT", "conflict", {
        current: { config: { ...resolved(), name: "Theirs" }, updatedAt: "2026-07-12T02:00:00Z" },
      })
    )
    const user = userEvent.setup()
    renderEditor()

    const name = screen.getByLabelText("Name")
    await user.clear(name)
    await user.type(name, "Mine")
    await user.click(screen.getByRole("button", { name: "Save" }))

    expect(await screen.findByText(/Someone else updated this persona/)).toBeInTheDocument()
    expect(screen.getByLabelText("Name")).toHaveValue("Mine")
  })

  it("adopts a self-avatar token bump mid-edit without a spurious conflict (INV-63)", async () => {
    const user = userEvent.setup()
    const { rerenderConfig } = renderEditor()

    const name = screen.getByLabelText("Name")
    await user.clear(name)
    await user.type(name, "Mine")

    // An avatar upload bumps the row's updated_at and rebroadcasts, refetching a
    // config with a NEW overrideUpdatedAt and a new avatarUrl but the still-old
    // (uncommitted) name. This is the user's own action, not a foreign commit.
    rerenderConfig(
      config({
        overrideUpdatedAt: "2026-07-12T03:00:00Z",
        resolved: { ...resolved(), avatarUrl: "avatars/ws_1/personas/persona_c1/123" },
      })
    )

    expect(screen.queryByText(/Someone else updated this persona/)).not.toBeInTheDocument()
    expect(screen.getByLabelText("Name")).toHaveValue("Mine")
  })

  it("surfaces a broadcast-delivered foreign edit inline and keeps local edits (INV-63)", async () => {
    const user = userEvent.setup()
    const { rerenderConfig } = renderEditor()

    const name = screen.getByLabelText("Name")
    await user.clear(name)
    await user.type(name, "Mine")

    // A concurrent admin committed a real field change (name), advancing the token
    // AND the resolved baseline — this must surface the conflict banner.
    rerenderConfig(
      config({
        overrideUpdatedAt: "2026-07-12T03:00:00Z",
        resolved: { ...resolved(), name: "Theirs" },
      })
    )

    expect(await screen.findByText(/Someone else updated this persona/)).toBeInTheDocument()
    expect(screen.getByLabelText("Name")).toHaveValue("Mine")
  })

  it("archives the persona and returns to the roster", async () => {
    const archive = vi.spyOn(personasApi, "archive").mockResolvedValue({ id: "persona_c1" } as never)
    const user = userEvent.setup()
    renderEditor()

    await user.click(screen.getByRole("button", { name: "Archive" }))
    const alert = await screen.findByRole("alertdialog")
    await user.click(within(alert).getByRole("button", { name: "Archive" }))

    await waitFor(() => expect(archive).toHaveBeenCalledWith("ws_1", "persona_c1"))
    expect(await screen.findByText("Workspace home")).toBeInTheDocument()
  })

  describe("Knowledge attachments", () => {
    it("renders a row per attachment with size and a processing badge (INV-46)", () => {
      renderEditor(
        config({
          attachments: [
            attachment({ id: "att_ready", filename: "handbook.pdf", sizeBytes: 12 * 1024, processingStatus: "ready" }),
            attachment({ id: "att_proc", filename: "notes.txt", sizeBytes: 2 * 1024, processingStatus: "processing" }),
          ],
        })
      )

      expect(screen.getByText("handbook.pdf")).toBeInTheDocument()
      expect(screen.getByText(/12\.0 KB/)).toBeInTheDocument()
      expect(screen.getByText("notes.txt")).toBeInTheDocument()
      expect(screen.getByText(/Processing/)).toBeInTheDocument()
    })

    it("uploads the picked file via the attachment mutation (no success toast, INV-63)", async () => {
      const upload = vi
        .spyOn(personasApi, "uploadAttachment")
        .mockResolvedValue(attachment({ id: "att_new", filename: "notes.txt", processingStatus: "processing" }))
      const successToast = vi.spyOn(toast, "success")
      const { container } = renderEditor()

      const file = new File(["hello"], "notes.txt", { type: "text/plain" })
      fireEvent.change(attachmentInput(container), { target: { files: [file] } })

      await waitFor(() => expect(upload).toHaveBeenCalledWith("ws_1", "persona_c1", file))
      expect(successToast).not.toHaveBeenCalled()
    })

    it("removes an attachment via the delete mutation", async () => {
      const del = vi.spyOn(personasApi, "deleteAttachment").mockResolvedValue(undefined)
      const user = userEvent.setup()
      renderEditor(config({ attachments: [attachment({ id: "att_x", filename: "handbook.pdf" })] }))

      await user.click(screen.getByRole("button", { name: "Remove handbook.pdf" }))

      await waitFor(() => expect(del).toHaveBeenCalledWith("ws_1", "persona_c1", "att_x"))
    })

    it("disables Add at the count cap and shows the reserved 'N of N files' hint (INV-21)", () => {
      const attachments = Array.from({ length: 5 }, (_, i) => attachment({ id: `att_${i}`, filename: `f${i}.pdf` }))
      renderEditor(config({ attachments }))

      expect(screen.getByRole("button", { name: /Add file/ })).toBeDisabled()
      expect(screen.getByText("5 of 5 files")).toBeInTheDocument()
    })

    it("toasts the server's rejection message on upload failure and fires no success toast (INV-11/63)", async () => {
      vi.spyOn(personasApi, "uploadAttachment").mockRejectedValue(
        new ApiError(400, "PERSONA_ATTACHMENT_LIMIT", "You can attach at most 5 files.")
      )
      const errorToast = vi.spyOn(toast, "error")
      const successToast = vi.spyOn(toast, "success")
      const { container } = renderEditor()

      const file = new File(["hello"], "notes.txt", { type: "text/plain" })
      fireEvent.change(attachmentInput(container), { target: { files: [file] } })

      await waitFor(() => expect(errorToast).toHaveBeenCalledWith("You can attach at most 5 files."))
      expect(successToast).not.toHaveBeenCalled()
    })
  })
})
