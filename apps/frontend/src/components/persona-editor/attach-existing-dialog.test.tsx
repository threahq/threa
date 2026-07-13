import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { toast } from "sonner"
import { render, screen, userEvent, waitFor } from "@/test"
import * as attachmentsApiModule from "@/api/attachments"
import * as preferencesModule from "@/contexts/preferences-context"
import { personasApi } from "@/api"
import { ApiError } from "@/api/client"
import { AttachExistingDialog } from "./attach-existing-dialog"

function makeItem(
  overrides: Partial<attachmentsApiModule.AttachmentSearchItem> = {}
): attachmentsApiModule.AttachmentSearchItem {
  return {
    id: "attach_a",
    workspaceId: "ws_1",
    streamId: "str_design",
    messageId: "msg_1",
    uploadedBy: "usr_1",
    filename: "handbook.md",
    mimeType: "text/markdown",
    sizeBytes: 1024,
    storageProvider: "s3",
    storagePath: "ws_1/attach_a/handbook.md",
    processingStatus: "completed",
    safetyStatus: "clean",
    createdAt: new Date("2026-05-01T10:00:00.000Z").toISOString() as unknown as Date,
    extraction: null,
    streamSlug: "design",
    streamName: "Design",
    streamType: "channel",
    uploaderSlug: "mira",
    uploaderName: "Mira",
    referenceCount: 0,
    ...overrides,
  } as attachmentsApiModule.AttachmentSearchItem
}

function personaAttachment(
  overrides: Partial<import("@threa/types").PersonaAttachmentItem> = {}
): import("@threa/types").PersonaAttachmentItem {
  return {
    id: "att_copy",
    filename: "handbook.md",
    mimeType: "text/markdown",
    sizeBytes: 1024,
    processingStatus: "ready",
    contextMode: "full",
    position: 0,
    createdAt: "2026-07-13T00:00:00Z",
    ...overrides,
  }
}

function renderDialog(onOpenChange = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const result = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AttachExistingDialog workspaceId="ws_1" personaId="persona_c1" open onOpenChange={onOpenChange} />
      </MemoryRouter>
    </QueryClientProvider>
  )
  return { ...result, onOpenChange }
}

describe("AttachExistingDialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(attachmentsApiModule.attachmentsApi, "getDownloadUrl").mockResolvedValue("https://example.test/blob")
    vi.spyOn(preferencesModule, "usePreferences").mockReturnValue({
      preferences: { dateFormat: "YYYY-MM-DD", timeFormat: "24h", timezone: "UTC" } as never,
    } as unknown as ReturnType<typeof preferencesModule.usePreferences>)
  })

  it("issues a persona-eligible-category search and renders the results", async () => {
    const searchSpy = vi
      .spyOn(attachmentsApiModule.attachmentsApi, "search")
      .mockResolvedValue({ items: [makeItem()], nextCursor: null })

    renderDialog()

    expect(await screen.findByText("handbook.md")).toBeInTheDocument()
    await waitFor(() => expect(searchSpy).toHaveBeenCalled())
    const body = searchSpy.mock.calls[0]![1]
    expect(body.categories).toEqual(expect.arrayContaining(["pdf", "doc", "sheet", "code"]))
    expect(body.categories).not.toContain("image")
  })

  it("drops server results whose mime is not persona-eligible (client-side belt-and-braces)", async () => {
    vi.spyOn(attachmentsApiModule.attachmentsApi, "search").mockResolvedValue({
      items: [makeItem(), makeItem({ id: "attach_xls", filename: "legacy.xls", mimeType: "application/vnd.ms-excel" })],
      nextCursor: null,
    })

    renderDialog()

    expect(await screen.findByText("handbook.md")).toBeInTheDocument()
    expect(screen.queryByText("legacy.xls")).not.toBeInTheDocument()
  })

  it("copies the picked file and closes on success (no success toast, INV-63)", async () => {
    vi.spyOn(attachmentsApiModule.attachmentsApi, "search").mockResolvedValue({
      items: [makeItem()],
      nextCursor: null,
    })
    const attachSpy = vi.spyOn(personasApi, "attachFromExisting").mockResolvedValue(personaAttachment())
    const successToast = vi.spyOn(toast, "success")
    const { onOpenChange } = renderDialog()

    await screen.findByText("handbook.md")
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: /handbook\.md/i }))

    await waitFor(() => expect(attachSpy).toHaveBeenCalledWith("ws_1", "persona_c1", "attach_a"))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(successToast).not.toHaveBeenCalled()
  })

  it("toasts the server's message and stays open when the copy is rejected (INV-11)", async () => {
    vi.spyOn(attachmentsApiModule.attachmentsApi, "search").mockResolvedValue({
      items: [makeItem()],
      nextCursor: null,
    })
    vi.spyOn(personasApi, "attachFromExisting").mockRejectedValue(
      new ApiError(400, "PERSONA_ATTACHMENT_SOURCE_NOT_CLEAN", "This file hasn’t finished a safety scan yet.")
    )
    const errorToast = vi.spyOn(toast, "error")
    const { onOpenChange } = renderDialog()

    await screen.findByText("handbook.md")
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: /handbook\.md/i }))

    await waitFor(() => expect(errorToast).toHaveBeenCalledWith("This file hasn’t finished a safety scan yet."))
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })
})
