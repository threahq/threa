import { forwardRef } from "react"
import { fireEvent, render } from "@testing-library/react"
import type { ScheduledMessageView } from "@threa/types"
import { afterEach, describe, expect, it, vi } from "vitest"
import { spyOnExport } from "@/test/spy"
import * as contextsModule from "@/contexts"
import * as hooksModule from "@/hooks"
import * as useAttachmentsModule from "@/hooks/use-attachments"
import * as useInputModeModule from "@/hooks/use-input-mode"
import * as useMentionablesModule from "@/hooks/use-mentionables"
import * as useMobileModule from "@/hooks/use-mobile"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as editorModule from "@/components/editor"
import { ScheduledEditDialog } from "./scheduled-edit-dialog"

const MockRichEditor = forwardRef(function MockRichEditor() {
  return <div data-testid="scheduled-rich-editor" />
})

const SCHEDULED_MESSAGE: ScheduledMessageView = {
  id: "sched_local_test",
  workspaceId: "workspace-1",
  userId: "user-1",
  streamId: "stream-1",
  parentMessageId: null,
  contentJson: { type: "doc", content: [{ type: "paragraph" }] },
  contentMarkdown: "",
  attachmentIds: [],
  metadata: null,
  scheduledFor: new Date(Date.now() + 60_000).toISOString(),
  status: "pending",
  sentMessageId: null,
  lastError: null,
  editActiveUntil: null,
  clientMessageId: "client-1",
  version: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  statusChangedAt: new Date().toISOString(),
}

describe("ScheduledEditDialog attachments", () => {
  afterEach(() => vi.restoreAllMocks())

  it("uses the attachment-row fallback when mobile inline insertion is disabled", () => {
    const handleFileSelect = vi.fn()
    const attachments = {
      pendingAttachments: [],
      getPendingAttachmentsSnapshot: () => [],
      fileInputRef: { current: null },
      handleFileSelect,
      uploadFile: vi.fn(),
      removeAttachment: vi.fn(),
      cancelUpload: vi.fn(),
      uploadedIds: [],
      isUploading: false,
      isReserving: false,
      hasFailed: false,
      clear: vi.fn(),
      restore: vi.fn(),
      imageCount: 0,
    } as unknown as ReturnType<typeof useAttachmentsModule.useAttachments>
    const mutation = {
      isPending: false,
      mutate: vi.fn(),
      mutateAsync: vi.fn(),
    }

    vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(true)
    vi.spyOn(useInputModeModule, "useInputMode").mockReturnValue("touch")
    vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
      preferences: { mobileInlineAttachments: false },
    } as ReturnType<typeof contextsModule.usePreferences>)
    vi.spyOn(useAttachmentsModule, "useAttachments").mockReturnValue(attachments)
    vi.spyOn(useMentionablesModule, "useMentionStreamContext").mockReturnValue(undefined)
    vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue([])
    vi.spyOn(hooksModule, "useUpdateScheduled").mockReturnValue(mutation as never)
    vi.spyOn(hooksModule, "useLockScheduledForEdit").mockReturnValue(mutation as never)
    vi.spyOn(hooksModule, "useReleaseScheduledEditLock").mockReturnValue(mutation as never)
    vi.spyOn(hooksModule, "useSendScheduledNow").mockReturnValue(mutation as never)
    vi.spyOn(hooksModule, "useCancelScheduled").mockReturnValue(mutation as never)
    spyOnExport(editorModule, "RichEditor").mockReturnValue(MockRichEditor as unknown as typeof editorModule.RichEditor)
    spyOnExport(editorModule, "EditorActionBar").mockReturnValue((() => null) as never)
    spyOnExport(editorModule, "EditorToolbar").mockReturnValue((() => null) as never)

    render(<ScheduledEditDialog workspaceId="workspace-1" scheduled={SCHEDULED_MESSAGE} onClose={vi.fn()} />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(["notes"], "notes.txt", { type: "text/plain" })

    fireEvent.change(input, { target: { files: [file] } })

    expect(Array.from(handleFileSelect.mock.calls[0]?.[0].target.files ?? [])).toEqual([file])
  })
})
