import { forwardRef, type ReactNode } from "react"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { ShareErrorCodes, type ScheduledMessageView } from "@threahq/types"
import { toast } from "sonner"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "@/api/client"
import { spyOnExport } from "@/test/spy"
import * as contextsModule from "@/contexts"
import * as hooksModule from "@/hooks"
import * as useAttachmentsModule from "@/hooks/use-attachments"
import * as useInputModeModule from "@/hooks/use-input-mode"
import * as useMentionablesModule from "@/hooks/use-mentionables"
import * as useMobileModule from "@/hooks/use-mobile"
import * as referenceAudienceModule from "@/hooks/use-reference-audience"
import type { ComposerSendWarning } from "@/lib/reference-audience"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as editorModule from "@/components/editor"
import { ScheduledEditDialog } from "./scheduled-edit-dialog"

const MockRichEditor = forwardRef(function MockRichEditor() {
  return <div data-testid="scheduled-rich-editor" />
})

/** Built per render: a send time fixed at import is in the past once the shard has run for a minute. */
const scheduledMessage = (): ScheduledMessageView => ({
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
})

function mockDialogDeps({
  attachments = {},
  update = vi.fn(),
  sendNow = vi.fn(),
  sendWarning = null,
}: {
  attachments?: Partial<ReturnType<typeof useAttachmentsModule.useAttachments>>
  update?: ReturnType<typeof vi.fn>
  sendNow?: ReturnType<typeof vi.fn>
  sendWarning?: ComposerSendWarning | null
} = {}) {
  const attachmentsHook = {
    pendingAttachments: [],
    getPendingAttachmentsSnapshot: () => [],
    fileInputRef: { current: null },
    handleFileSelect: vi.fn(),
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
    ...attachments,
  } as unknown as ReturnType<typeof useAttachmentsModule.useAttachments>
  const mutation = {
    isPending: false,
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
  }

  vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
    preferences: { mobileInlineAttachments: false },
  } as ReturnType<typeof contextsModule.usePreferences>)
  vi.spyOn(useAttachmentsModule, "useAttachments").mockReturnValue(attachmentsHook)
  vi.spyOn(useMentionablesModule, "useMentionStreamContext").mockReturnValue(undefined)
  vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue([])
  vi.spyOn(hooksModule, "useUpdateScheduled").mockReturnValue({ ...mutation, mutateAsync: update } as never)
  vi.spyOn(hooksModule, "useLockScheduledForEdit").mockReturnValue({
    ...mutation,
    mutateAsync: vi.fn(() => new Promise(() => {})),
  } as never)
  vi.spyOn(hooksModule, "useReleaseScheduledEditLock").mockReturnValue(mutation as never)
  vi.spyOn(hooksModule, "useSendScheduledNow").mockReturnValue({ ...mutation, mutateAsync: sendNow } as never)
  vi.spyOn(hooksModule, "useCancelScheduled").mockReturnValue(mutation as never)
  spyOnExport(referenceAudienceModule, "useReferenceAudience").mockReturnValue(() => ({
    sendWarning,
    audienceByStreamId: new Map(),
    awaitSendWarning: null,
    sentReferenceKeys: new Set<string>(),
  }))
  spyOnExport(editorModule, "RichEditor").mockReturnValue(MockRichEditor as unknown as typeof editorModule.RichEditor)
  spyOnExport(editorModule, "EditorActionBar").mockReturnValue(
    (({ trailingContent }: { trailingContent?: ReactNode }) => trailingContent) as never
  )
  spyOnExport(editorModule, "EditorToolbar").mockReturnValue((() => null) as never)
}

describe("ScheduledEditDialog attachments", () => {
  afterEach(() => vi.restoreAllMocks())

  it("uses the attachment-row fallback when mobile inline insertion is disabled", () => {
    const handleFileSelect = vi.fn()
    vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(true)
    vi.spyOn(useInputModeModule, "useInputMode").mockReturnValue("touch")
    mockDialogDeps({ attachments: { handleFileSelect } })

    render(<ScheduledEditDialog workspaceId="workspace-1" scheduled={scheduledMessage()} onClose={vi.fn()} />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(["notes"], "notes.txt", { type: "text/plain" })

    fireEvent.change(input, { target: { files: [file] } })

    expect(Array.from(handleFileSelect.mock.calls[0]?.[0].target.files ?? [])).toEqual([file])
  })
})

describe("ScheduledEditDialog share privacy", () => {
  afterEach(() => vi.restoreAllMocks())

  it.each([
    { button: "Save", confirmLabel: "Save anyway" },
    { button: "Send now", confirmLabel: "Send anyway" },
  ])(
    "asks before $button exposes a share and retries it with consent on $confirmLabel",
    async ({ button, confirmLabel }) => {
      const warningToast = vi.spyOn(toast, "warning").mockReturnValue("w1")
      const update = vi
        .fn()
        .mockRejectedValueOnce(new ApiError(409, ShareErrorCodes.PRIVACY_CONFIRMATION_REQUIRED, "Confirm"))
        .mockResolvedValueOnce({ ...scheduledMessage(), id: "sched_server_test", version: 2 })
      mockDialogDeps({ update })
      const onClose = vi.fn()

      render(
        <ScheduledEditDialog
          workspaceId="workspace-1"
          scheduled={{ ...scheduledMessage(), id: "sched_server_test" }}
          onClose={onClose}
        />
      )
      fireEvent.click(screen.getByRole("button", { name: button }))
      await waitFor(() => expect(warningToast).toHaveBeenCalled())
      const { action } = warningToast.mock.calls[0]?.[1] as { action: { label: string; onClick: () => void } }
      const closedBeforeConsent = onClose.mock.calls.length
      act(() => action.onClick())

      await waitFor(() => expect(onClose).toHaveBeenCalled())
      expect({
        action: action.label,
        closedBeforeConsent,
        consent: update.mock.calls.map(([call]) => call.input.confirmedPrivacyWarning),
      }).toEqual({ action: confirmLabel, closedBeforeConsent: 0, consent: [undefined, true] })
    }
  )
})

describe("ScheduledEditDialog audience question", () => {
  afterEach(() => vi.restoreAllMocks())

  const revealWarning: ComposerSendWarning = {
    warning: {
      tone: "reveal",
      lead: { streamId: "stream_src", count: 2, sampleUserIds: [] },
      exposed: { reveal: ["stream_src"], unreachable: [] },
      convertibleStreamIds: ["stream_src"],
    },
    names: [],
    settled: true,
    targetKey: "stream:stream-1",
  }

  function renderAsking() {
    vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(false)
    const update = vi.fn().mockResolvedValue({ ...scheduledMessage(), id: "sched_server_test", version: 2 })
    const sendNow = vi.fn().mockResolvedValue({})
    mockDialogDeps({ update, sendNow, sendWarning: revealWarning })
    const onClose = vi.fn()
    render(
      <ScheduledEditDialog
        workspaceId="workspace-1"
        scheduled={{ ...scheduledMessage(), id: "sched_server_test" }}
        onClose={onClose}
      />
    )
    return { update, sendNow, onClose }
  }

  it("asks before Send now reveals a share and sends it with consent from the question", async () => {
    const { update, sendNow, onClose } = renderAsking()

    fireEvent.click(screen.getByRole("button", { name: /^Send now/ }))
    const ask = await screen.findByTestId("send-ask")
    const updatesBeforeAnswer = update.mock.calls.length
    fireEvent.click(within(ask).getByRole("button", { name: /^Send/ }))

    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect({
      updatesBeforeAnswer,
      consent: update.mock.calls.map(([call]) => call.input.confirmedPrivacyWarning),
      sentNow: sendNow.mock.calls.map(([id]) => id),
    }).toEqual({ updatesBeforeAnswer: 0, consent: [true], sentNow: ["sched_server_test"] })
  })

  it("closes the question on Escape and keeps the dialog open", async () => {
    const { update, onClose } = renderAsking()

    fireEvent.click(screen.getByRole("button", { name: /^Save/ }))
    await screen.findByTestId("send-ask")
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })

    await waitFor(() => expect(screen.queryByTestId("send-ask")).toBeNull())
    expect({ updates: update.mock.calls.length, closed: onClose.mock.calls.length }).toEqual({ updates: 0, closed: 0 })
  })

  it("takes a question asked as Save away once the send time passes", async () => {
    renderAsking()

    fireEvent.click(screen.getByRole("button", { name: /^Save/ }))
    await screen.findByTestId("send-ask")
    const later = Date.now() + 5 * 60_000
    vi.spyOn(Date, "now").mockReturnValue(later)

    await waitFor(() => expect(screen.queryByTestId("send-ask")).toBeNull(), { timeout: 3000 })
  })

  /** The audience lookup stays pending until `resolveReveal`, and the clock can be moved past the send time. */
  function renderPendingLookup() {
    vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(false)
    let settle: (value: ComposerSendWarning | null) => void = () => {}
    let settled: ComposerSendWarning | null = null
    const update = vi.fn().mockResolvedValue({ ...scheduledMessage(), id: "sched_server_test", version: 2 })
    const sendNow = vi.fn().mockResolvedValue({})
    mockDialogDeps({ update, sendNow })
    spyOnExport(referenceAudienceModule, "useReferenceAudience").mockReturnValue(() => ({
      sendWarning: settled,
      audienceByStreamId: new Map(),
      awaitSendWarning: () => new Promise((resolve) => (settle = resolve)),
      sentReferenceKeys: new Set<string>(),
    }))
    render(
      <ScheduledEditDialog
        workspaceId="workspace-1"
        scheduled={{ ...scheduledMessage(), id: "sched_server_test" }}
        onClose={vi.fn()}
      />
    )
    return {
      update,
      sendNow,
      passSendTime: async () => {
        vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5 * 60_000)
        await screen.findByRole("button", { name: /^Send$/ }, { timeout: 3000 })
      },
      resolveReveal: () =>
        act(async () => {
          settled = revealWarning
          settle(revealWarning)
        }),
    }
  }

  it("drops a Save still awaiting its audience once the send time passes", async () => {
    const { update, passSendTime, resolveReveal } = renderPendingLookup()

    fireEvent.click(screen.getByRole("button", { name: /^Save/ }))
    await passSendTime()
    await resolveReveal()

    expect({ asked: screen.queryByTestId("send-ask"), updates: update.mock.calls.length }).toEqual({
      asked: null,
      updates: 0,
    })
  })

  it("still asks about a Send now pressed just before the send time passes", async () => {
    const { passSendTime, resolveReveal } = renderPendingLookup()

    fireEvent.click(screen.getByRole("button", { name: /^Send now/ }))
    await passSendTime()
    await resolveReveal()

    expect(screen.getByTestId("send-ask")).toBeTruthy()
  })
})
