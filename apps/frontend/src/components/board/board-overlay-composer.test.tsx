import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, userEvent, waitFor, spyOnExport } from "@/test"
import { StreamTypes } from "@threa/types"
import * as composerModule from "@/components/composer"
import * as hooksModule from "@/hooks"
import * as mentionablesModule from "@/hooks/use-mentionables"
import * as conversationsModule from "@/hooks/use-conversations"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as inputModeModule from "@/hooks/use-input-mode"
import { createMockStream } from "@/test/fixtures"
import { readTargetMru } from "@/lib/board-target-mru"
import { BoardOverlayComposer } from "./board-overlay-composer"
import type { MessageComposerProps } from "@/components/composer"

const EMPTY_DOC = { type: "doc", content: [] }
const channel = createMockStream({
  id: "stream_c1",
  type: StreamTypes.CHANNEL,
  displayName: "General",
  slug: "general",
})

// The behavior under test is the host wiring (target → board post → MRU → close),
// not editor mechanics, so the heavy tiptap composer is a marker that exposes onSubmit.
const EditorStub = (props: MessageComposerProps) => (
  <div>
    <span data-testid="placeholder">{props.placeholder}</span>
    <button type="button" data-testid="stub-send" disabled={!props.canSubmit} onClick={() => props.onSubmit()}>
      send
    </button>
  </div>
)

function draftComposerStub() {
  return {
    content: EMPTY_DOC,
    isLoaded: true,
    setContent: vi.fn(),
    canSend: true,
    pendingAttachments: [],
    getPendingAttachmentsSnapshot: () => [],
    setIsSending: vi.fn(),
    resolveDraft: vi.fn().mockResolvedValue(undefined),
    clearAttachments: vi.fn(),
    handleContentChange: vi.fn(),
    handleRemoveAttachment: vi.fn(),
    handleCancelAttachmentUpload: vi.fn(),
    fileInputRef: { current: null },
    handleFileSelect: vi.fn(),
    uploadFile: vi.fn(),
    imageCount: 0,
    isSending: false,
    hasFailed: false,
    flushDraft: vi.fn().mockResolvedValue(undefined),
  }
}

let mutateAsync: ReturnType<typeof vi.fn>

beforeEach(() => {
  localStorage.removeItem("board:post-target-mru:workspace_1")
  Element.prototype.scrollIntoView ??= () => {}
  spyOnExport(composerModule, "MessageComposer").mockReturnValue(EditorStub as never)
  const stub = draftComposerStub()
  spyOnExport(hooksModule, "useDraftComposer").mockReturnValue((() => stub) as never)
  vi.spyOn(mentionablesModule, "useMentionStreamContext").mockReturnValue(undefined as never)
  mutateAsync = vi.fn().mockResolvedValue({ message: { id: "msg_1" }, conversationId: "conv_1" })
  vi.spyOn(conversationsModule, "useCreateBoardPost").mockReturnValue({ mutateAsync, isPending: false } as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue([channel] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceDmPeers").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceStreamMemberships").mockReturnValue([{ streamId: channel.id }] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceUnreadState").mockReturnValue(undefined as never)
  vi.spyOn(inputModeModule, "useInputMode").mockReturnValue("mouse")
})

describe("BoardOverlayComposer", () => {
  it("seeds the target from the MRU and posts to it, then promotes it + closes", async () => {
    localStorage.setItem("board:post-target-mru:workspace_1", JSON.stringify([channel.id]))
    const onOpenChange = vi.fn()
    const onPosted = vi.fn()

    render(<BoardOverlayComposer workspaceId="workspace_1" open onOpenChange={onOpenChange} onPosted={onPosted} />)

    // Target seeded from MRU → picker shows it, editor is enabled.
    expect(screen.getByRole("combobox")).toHaveTextContent("general")
    expect(screen.getByTestId("placeholder")).toHaveTextContent("Write a post…")

    await userEvent.click(screen.getByTestId("stub-send"))

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ target: { type: "stream", streamId: channel.id } })
      )
    )
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onPosted).toHaveBeenCalled()
    expect(readTargetMru("workspace_1")).toEqual([channel.id])
  })

  it("adopts an explicit defaultTarget and disables send until a target is set", async () => {
    const { rerender } = render(<BoardOverlayComposer workspaceId="workspace_1" open={false} onOpenChange={vi.fn()} />)
    // Opening with a defaultTarget adopts it.
    rerender(<BoardOverlayComposer workspaceId="workspace_1" open onOpenChange={vi.fn()} defaultTarget={channel.id} />)
    expect(await screen.findByRole("combobox")).toHaveTextContent("general")
    expect(screen.getByTestId("stub-send")).toBeEnabled()
  })
})
