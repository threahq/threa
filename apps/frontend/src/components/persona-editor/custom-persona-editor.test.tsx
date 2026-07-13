import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { forwardRef, useImperativeHandle } from "react"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { toast } from "sonner"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  PERSONA_ATTACHMENT_MAX_COUNT,
  type PersonaAttachmentItem,
  type JSONContent,
  type PersonaConfigResponse,
  type PersonaResolvedConfig,
} from "@threa/types"
import { personasApi } from "@/api"
import { ApiError } from "@/api/client"
import { spyOnExport } from "@/test/spy"
import * as editorModule from "@/components/editor"
import * as uploadManager from "@/lib/uploads/upload-manager"
import type { UploadJob } from "@/lib/uploads/upload-manager"
import { CustomPersonaEditor } from "./custom-persona-editor"

/**
 * A controllable stand-in for the app-level upload manager (INV-48 — spy the
 * seam, don't vi.mock the module). Uploads are driven manually: `startUpload`
 * creates a live job, and the returned controls settle / progress / fail it so a
 * test can prove the section binds on settle without touching the real transport.
 */
function installFakeUploadManager() {
  const jobs = new Map<string, UploadJob>()
  const listeners = new Set<() => void>()
  let version = 0
  let counter = 0
  const emit = () => {
    version += 1
    for (const listener of listeners) listener()
  }
  const findUploadJob = (id: string): UploadJob | undefined =>
    jobs.get(id) ?? [...jobs.values()].find((job) => job.attachmentId === id)

  const startUpload = vi.fn((workspaceId: string, file: File): UploadJob => {
    counter += 1
    const jobId = `job_${counter}`
    const job: UploadJob = {
      jobId,
      workspaceId,
      attachmentId: `attach_${counter}`,
      filename: file.name,
      mimeType: file.type || "application/octet-stream",
      sizeBytes: file.size,
      e2e: false,
      status: "uploading",
      progress: 0,
      released: false,
    }
    jobs.set(jobId, job)
    emit()
    return job
  })
  const removeUpload = vi.fn((id: string) => {
    const job = findUploadJob(id)
    if (job) {
      jobs.delete(job.jobId)
      emit()
    }
  })
  const retryUpload = vi.fn()

  spyOnExport(uploadManager, "startUpload").mockImplementation(() => startUpload as never)
  spyOnExport(uploadManager, "findUploadJob").mockImplementation(() => findUploadJob as never)
  spyOnExport(uploadManager, "removeUpload").mockImplementation(() => removeUpload as never)
  spyOnExport(uploadManager, "retryUpload").mockImplementation(() => retryUpload as never)
  spyOnExport(uploadManager, "claimUpload").mockImplementation(() => ((id: string) => findUploadJob(id)) as never)
  spyOnExport(uploadManager, "releaseUploads").mockImplementation(() => (() => undefined) as never)
  spyOnExport(uploadManager, "subscribeUploads").mockImplementation(
    () =>
      ((listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }) as never
  )
  spyOnExport(uploadManager, "getUploadsVersion").mockImplementation(() => (() => version) as never)

  const patch = (jobId: string, next: Partial<UploadJob>) => {
    const job = jobs.get(jobId)
    if (job) jobs.set(jobId, { ...job, ...next })
    act(() => emit())
  }
  return {
    startUpload,
    removeUpload,
    retryUpload,
    settle: (jobId: string) => patch(jobId, { status: "uploaded", progress: 1 }),
    setProgress: (jobId: string, progress: number) => patch(jobId, { progress }),
    fail: (jobId: string, error: string) => patch(jobId, { status: "error", error, retryable: true }),
  }
}

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
    contextMode: "full",
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

    it("picks a file, uploads it through the manager, and binds on settle (no success toast, INV-63)", async () => {
      const manager = installFakeUploadManager()
      const bind = vi
        .spyOn(personasApi, "bindAttachment")
        .mockResolvedValue(attachment({ id: "attach_1", filename: "notes.txt", processingStatus: "processing" }))
      const successToast = vi.spyOn(toast, "success")
      const { container } = renderEditor()

      const file = new File(["hello"], "notes.txt", { type: "text/plain" })
      fireEvent.change(attachmentInput(container), { target: { files: [file] } })
      expect(manager.startUpload).toHaveBeenCalledTimes(1)

      // Bind fires only once the transport settles — never mid-upload.
      expect(bind).not.toHaveBeenCalled()
      manager.settle("job_1")

      await waitFor(() => expect(bind).toHaveBeenCalledWith("ws_1", "persona_c1", "attach_1"))
      expect(successToast).not.toHaveBeenCalled()
    })

    it("renders an uploading row with progress while the transfer runs (INV-21)", () => {
      const manager = installFakeUploadManager()
      vi.spyOn(personasApi, "bindAttachment").mockResolvedValue(attachment())
      const { container } = renderEditor()

      const file = new File(["hello world"], "notes.txt", { type: "text/plain" })
      fireEvent.change(attachmentInput(container), { target: { files: [file] } })
      manager.setProgress("job_1", 0.4)

      expect(screen.getByText("notes.txt")).toBeInTheDocument()
      expect(screen.getByText(/Uploading… 40%/)).toBeInTheDocument()
    })

    it("toasts and clears the pending row when the bind fails (INV-11/63)", async () => {
      const manager = installFakeUploadManager()
      vi.spyOn(personasApi, "bindAttachment").mockRejectedValue(
        new ApiError(400, "PERSONA_ATTACHMENT_LIMIT", "You can attach at most 50 files.")
      )
      const errorToast = vi.spyOn(toast, "error")
      const successToast = vi.spyOn(toast, "success")
      const { container } = renderEditor()

      const file = new File(["hello"], "notes.txt", { type: "text/plain" })
      fireEvent.change(attachmentInput(container), { target: { files: [file] } })
      manager.settle("job_1")

      await waitFor(() => expect(errorToast).toHaveBeenCalledWith("You can attach at most 50 files."))
      // The settled-but-unbound reservation is cleaned up and the row removed.
      await waitFor(() => expect(manager.removeUpload).toHaveBeenCalledWith("job_1"))
      await waitFor(() => expect(screen.queryByText("notes.txt")).not.toBeInTheDocument())
      expect(successToast).not.toHaveBeenCalled()
    })

    it("rejects a disallowed mime type client-side before any upload starts (INV-11)", () => {
      const manager = installFakeUploadManager()
      const errorToast = vi.spyOn(toast, "error")
      const { container } = renderEditor()

      const file = new File(["binary"], "logo.png", { type: "image/png" })
      fireEvent.change(attachmentInput(container), { target: { files: [file] } })

      expect(manager.startUpload).not.toHaveBeenCalled()
      expect(errorToast).toHaveBeenCalledWith(expect.stringContaining("logo.png"))
    })

    it("uploads two files picked in one go", () => {
      const manager = installFakeUploadManager()
      vi.spyOn(personasApi, "bindAttachment").mockResolvedValue(attachment())
      const { container } = renderEditor()

      const files = [
        new File(["a"], "a.txt", { type: "text/plain" }),
        new File(["b"], "b.md", { type: "text/markdown" }),
      ]
      fireEvent.change(attachmentInput(container), { target: { files } })

      expect(manager.startUpload).toHaveBeenCalledTimes(2)
      expect(screen.getByText("a.txt")).toBeInTheDocument()
      expect(screen.getByText("b.md")).toBeInTheDocument()
    })

    it("takes only the files that fit the remaining cap and says what was dropped (INV-11)", () => {
      const manager = installFakeUploadManager()
      vi.spyOn(personasApi, "bindAttachment").mockResolvedValue(attachment())
      const errorToast = vi.spyOn(toast, "error")
      // One slot left.
      const attachments = Array.from({ length: PERSONA_ATTACHMENT_MAX_COUNT - 1 }, (_, i) =>
        attachment({ id: `att_${i}`, filename: `f${i}.pdf` })
      )
      const { container } = renderEditor(config({ attachments }))

      const files = [new File(["a"], "a.txt", { type: "text/plain" }), new File(["b"], "b.txt", { type: "text/plain" })]
      fireEvent.change(attachmentInput(container), { target: { files } })

      expect(manager.startUpload).toHaveBeenCalledTimes(1)
      expect(errorToast).toHaveBeenCalledWith(expect.stringContaining("Only 1 more file"))
    })

    it("removes an attachment via the delete mutation", async () => {
      const del = vi.spyOn(personasApi, "deleteAttachment").mockResolvedValue(undefined)
      const user = userEvent.setup()
      renderEditor(config({ attachments: [attachment({ id: "att_x", filename: "handbook.pdf" })] }))

      await user.click(screen.getByRole("button", { name: "Remove handbook.pdf" }))

      await waitFor(() => expect(del).toHaveBeenCalledWith("ws_1", "persona_c1", "att_x"))
    })

    it("shows the context mode for each ready attachment (INV-46)", () => {
      renderEditor(
        config({
          attachments: [
            attachment({ id: "att_full", filename: "full.txt", processingStatus: "ready", contextMode: "full" }),
            attachment({ id: "att_sum", filename: "sum.txt", processingStatus: "ready", contextMode: "summary" }),
            attachment({ id: "att_name", filename: "name.txt", processingStatus: "ready", contextMode: "name_only" }),
          ],
        })
      )

      expect(screen.getByText(/In full/)).toBeInTheDocument()
      expect(screen.getByText(/Summary only/)).toBeInTheDocument()
      expect(screen.getByText(/Name only/)).toBeInTheDocument()
    })

    it("disables Add at the count cap and shows the reserved 'N of N files' hint (INV-21)", () => {
      const attachments = Array.from({ length: PERSONA_ATTACHMENT_MAX_COUNT }, (_, i) =>
        attachment({ id: `att_${i}`, filename: `f${i}.pdf` })
      )
      renderEditor(config({ attachments }))

      expect(screen.getByRole("button", { name: /Add file/ })).toBeDisabled()
      expect(
        screen.getByText(`${PERSONA_ATTACHMENT_MAX_COUNT} of ${PERSONA_ATTACHMENT_MAX_COUNT} files`)
      ).toBeInTheDocument()
    })
  })
})
