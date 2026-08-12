import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { MemoryRouter } from "react-router-dom"
import { spyOnExport } from "@/test/spy"
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { forwardRef, useEffect, useImperativeHandle, useState, type ForwardedRef } from "react"
import { MessageComposer } from "./message-composer"
import type { CachedDraft } from "@/hooks"
import type { PendingAttachment } from "@/hooks/use-attachments"
import type { JSONContent } from "@threa/types"
import * as useMobileModule from "@/hooks/use-mobile"
import * as contextsModule from "@/contexts"
import * as editorModule from "@/components/editor"
import * as micButtonModule from "./mic-button"
import * as pendingAttachmentsModule from "@/components/timeline/pending-attachments"
import { queueComposerCommandRequest } from "@/stores/composer-command-request-store"

let isMobileMockValue = false
const mockRichEditorFocus = vi.fn()
const mockInsertFiles = vi.fn(() => true)
const mockInsertTranscribedText = vi.fn()
const mockInsertDictationChunk = vi.fn()

type MockEditorInstance = {
  id: string
  getJSON: () => JSONContent
  isActive: () => boolean
  on: () => void
  off: () => void
}

const MockRichEditor = forwardRef<
  {
    focus: () => void
    insertMention: () => void
    insertSlash: () => void
    insertEmoji: () => void
    openSnippetEditor: () => void
    insertFiles: (files: File[]) => boolean
    insertTranscribedText: (text: string, options?: { joinPrevious?: boolean }) => void
    insertDictationChunk: (args: { chunkId: string; contentJson: JSONContent }) => void
    getEditor: () => MockEditorInstance | null
  },
  {
    value: JSONContent
    onChange: (v: JSONContent) => void
    onSubmit: () => void
    placeholder: string
    disabled: boolean
    ariaLabel?: string
    ariaDescribedBy?: string
  }
>(function MockRichEditor({ value, onChange, onSubmit, placeholder, disabled, ariaLabel, ariaDescribedBy }, ref) {
  const valueRef = { current: value }
  valueRef.current = value
  const [editorInstance, setEditorInstance] = useState<MockEditorInstance | null>(null)
  useEffect(() => {
    const timer = setTimeout(
      () =>
        setEditorInstance({
          id: "mock-editor",
          getJSON: () => valueRef.current,
          isActive: () => false,
          on: () => undefined,
          off: () => undefined,
        }),
      0
    )
    return () => clearTimeout(timer)
  }, [])

  useImperativeHandle(
    ref,
    () => ({
      focus: mockRichEditorFocus,
      insertMention: () => undefined,
      insertSlash: () => undefined,
      insertEmoji: () => undefined,
      openSnippetEditor: () => undefined,
      insertFiles: mockInsertFiles,
      insertTranscribedText: mockInsertTranscribedText,
      insertDictationChunk: mockInsertDictationChunk,
      getEditor: () => editorInstance,
    }),
    [editorInstance]
  )

  return (
    <div data-testid="rich-editor-wrapper">
      <textarea
        data-testid="rich-editor"
        data-content-type="json"
        onChange={(e) => {
          // Simulate content change by creating a simple doc with the text
          const text = e.target.value
          onChange({
            type: "doc",
            content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : undefined }],
          })
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.metaKey) onSubmit()
        }}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
      />
    </div>
  )
})

const MockEditorToolbar = ({
  editor,
  isVisible,
  showSpecialInputControls,
}: {
  editor: { id: string } | null
  isVisible: boolean
  showSpecialInputControls?: boolean
}) =>
  isVisible ? (
    <div
      data-testid="mobile-editor-toolbar"
      data-has-editor={editor ? "yes" : "no"}
      data-has-special-input-controls={showSpecialInputControls ? "yes" : "no"}
    >
      {showSpecialInputControls && (
        <>
          <button type="button">Indent</button>
          <button type="button">Dedent</button>
        </>
      )}
    </div>
  ) : null

const MockEditorActionBar = (props: Record<string, unknown>) => (
  <div data-testid="editor-action-bar">
    <button
      type="button"
      aria-label="Formatting"
      onClick={() => (props.onFormatOpenChange as (v: boolean) => void)!(!(props.formatOpen as boolean))}
    >
      Aa
    </button>
    {props.trailingContent as any}
  </div>
)

const EMPTY_DOC: JSONContent = { type: "doc", content: [{ type: "paragraph" }] }

describe("MessageComposer", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mockRichEditorFocus.mockClear()
    mockInsertFiles.mockClear()
    mockInsertTranscribedText.mockClear()
    mockInsertDictationChunk.mockClear()
    isMobileMockValue = false
    vi.useRealTimers()
    vi.spyOn(useMobileModule, "useIsMobile").mockImplementation(() => isMobileMockValue)
    spyOnExport(editorModule, "RichEditor").mockReturnValue(MockRichEditor as unknown as typeof editorModule.RichEditor)
    spyOnExport(editorModule, "EditorToolbar").mockReturnValue(
      MockEditorToolbar as unknown as typeof editorModule.EditorToolbar
    )
    spyOnExport(editorModule, "EditorActionBar").mockReturnValue(
      MockEditorActionBar as unknown as typeof editorModule.EditorActionBar
    )
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const defaultProps = {
    content: EMPTY_DOC,
    onContentChange: vi.fn(),
    pendingAttachments: [] as PendingAttachment[],
    onRemoveAttachment: vi.fn(),
    fileInputRef: { current: null },
    onFileSelect: vi.fn(),
    onSubmit: vi.fn(),
    canSubmit: false,
  }

  it("preserves active interim before the composer and editor refs unmount", () => {
    const recovered: JSONContent = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "visible interim" }] }],
    }
    const prepareSendAsIs = vi.fn()
    const MockMicButton = forwardRef(function MockMicButton(
      props: { onInsertPolishedChunk: (args: { chunkId: string; contentJson: JSONContent }) => void },
      ref: ForwardedRef<{ abort: () => void; prepareSendAsIs: () => void }>
    ) {
      useImperativeHandle(ref, () => ({
        abort: vi.fn(),
        prepareSendAsIs: () => {
          prepareSendAsIs()
          props.onInsertPolishedChunk({ chunkId: "local_recovery_1", contentJson: recovered })
        },
      }))
      return null
    })
    spyOnExport(micButtonModule, "MicButton").mockReturnValue(
      MockMicButton as unknown as typeof micButtonModule.MicButton
    )

    const { unmount } = render(<MessageComposer {...defaultProps} workspaceId="ws_1" scopeId="stream_a" />)
    unmount()

    expect(prepareSendAsIs).toHaveBeenCalledOnce()
    expect(mockInsertDictationChunk).toHaveBeenCalledWith({
      chunkId: "local_recovery_1",
      contentJson: recovered,
    })
  })

  it("forwards hard-join recovery through the plain committed-text editor seam", async () => {
    const MockMicButton = forwardRef(function MockMicButton(
      props: { onInsertText: (text: string, options?: { joinPrevious?: boolean }) => void },
      ref: ForwardedRef<{ abort: () => void; prepareSendAsIs: () => void }>
    ) {
      useImperativeHandle(ref, () => ({ abort: vi.fn(), prepareSendAsIs: vi.fn() }))
      useEffect(() => {
        props.onInsertText("lo", { joinPrevious: true })
      }, [props])
      return null
    })
    spyOnExport(micButtonModule, "MicButton").mockReturnValue(
      MockMicButton as unknown as typeof micButtonModule.MicButton
    )

    render(<MessageComposer {...defaultProps} workspaceId="ws_1" />)

    await waitFor(() => expect(mockInsertTranscribedText).toHaveBeenCalledWith("lo", { joinPrevious: true }))
  })

  it("aborts active dictation when a nonempty draft is cleared", async () => {
    const abort = vi.fn()
    const MockMicButton = forwardRef(function MockMicButton(
      props: { onActiveChange: (active: boolean) => void },
      ref: ForwardedRef<{ abort: () => void; prepareSendAsIs: () => void }>
    ) {
      useImperativeHandle(ref, () => ({ abort, prepareSendAsIs: vi.fn() }))
      useEffect(() => props.onActiveChange(true), [props])
      return null
    })
    spyOnExport(micButtonModule, "MicButton").mockReturnValue(
      MockMicButton as unknown as typeof micButtonModule.MicButton
    )
    const nonempty: JSONContent = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "draft" }] }],
    }
    const { rerender } = render(<MessageComposer {...defaultProps} workspaceId="ws_1" content={nonempty} />)

    rerender(<MessageComposer {...defaultProps} workspaceId="ws_1" content={EMPTY_DOC} />)

    await waitFor(() => expect(abort).toHaveBeenCalledOnce())
  })

  describe("rendering", () => {
    it("should render the editor", () => {
      render(<MessageComposer {...defaultProps} />)

      expect(screen.getByTestId("rich-editor")).toBeInTheDocument()
    })

    it("prepends a queued runtime command without dropping the existing draft", async () => {
      const onContentChange = vi.fn()
      const content: JSONContent = {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "focus on tests" }] }],
      }
      render(
        <MessageComposer
          {...defaultProps}
          streamId="stream_steer"
          content={content}
          onContentChange={onContentChange}
        />
      )

      act(() => queueComposerCommandRequest("stream_steer", "/steer "))

      await waitFor(() =>
        expect(onContentChange).toHaveBeenCalledWith({
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "/steer " },
                { type: "text", text: "focus on tests" },
              ],
            },
          ],
        })
      )
      await waitFor(() => expect(mockRichEditorFocus).toHaveBeenCalledTimes(1))
    })

    it("should render the upload button", () => {
      render(<MessageComposer {...defaultProps} />)

      // Upload button has aria-label "Attach files" via tooltip
      expect(screen.getByRole("button", { name: /attach files/i })).toBeInTheDocument()
    })

    it("should render the submit button with default label", () => {
      render(<MessageComposer {...defaultProps} />)

      expect(screen.getByRole("button", { name: /send/i })).toBeInTheDocument()
    })

    it("should render custom submit label", () => {
      render(<MessageComposer {...defaultProps} submitLabel="Reply" />)

      expect(screen.getByRole("button", { name: /reply/i })).toBeInTheDocument()
    })

    it("should render custom placeholder", () => {
      render(<MessageComposer {...defaultProps} placeholder="Write a reply..." />)

      expect(screen.getByPlaceholderText("Write a reply...")).toBeInTheDocument()
    })

    it("should give the editor an accessible name and instructions", () => {
      render(<MessageComposer {...defaultProps} />)

      const editor = screen.getByRole("textbox", { name: "Message input" })
      const instructions = screen.getByText(/Tab and Shift\+Tab indent content\./)

      expect(editor).toHaveAttribute("aria-describedby", instructions.getAttribute("id"))
      expect(instructions).toHaveTextContent("Press Escape to leave the editor.")
    })

    it("should announce fullscreen escape instructions when expanded", () => {
      render(<MessageComposer {...defaultProps} expanded />)

      expect(screen.getByRole("textbox", { name: "Fullscreen message editor" })).toBeInTheDocument()
      expect(screen.getByText(/Press Escape again to close the fullscreen editor\./)).toBeInTheDocument()
    })

    it("should only consume shell escape when collapse is available", () => {
      const { rerender } = render(<MessageComposer {...defaultProps} expanded />)

      const instructions = screen.getByText(/Press Escape again to close the fullscreen editor\./)
      const shell = instructions.parentElement as HTMLDivElement
      const escapeWithoutCollapse = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      })

      shell.dispatchEvent(escapeWithoutCollapse)

      expect(escapeWithoutCollapse.defaultPrevented).toBe(false)

      const onCollapse = vi.fn()
      rerender(<MessageComposer {...defaultProps} expanded onCollapse={onCollapse} />)

      const escapeWithCollapse = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      })

      shell.dispatchEvent(escapeWithCollapse)

      expect(escapeWithCollapse.defaultPrevented).toBe(true)
      expect(onCollapse).toHaveBeenCalledOnce()
    })
  })

  describe("submit button states", () => {
    it("should disable submit button when canSubmit is false", () => {
      render(<MessageComposer {...defaultProps} canSubmit={false} />)

      expect(screen.getByRole("button", { name: /send/i })).toBeDisabled()
    })

    it("should enable submit button when canSubmit is true", () => {
      render(<MessageComposer {...defaultProps} canSubmit={true} />)

      expect(screen.getByRole("button", { name: /send/i })).not.toBeDisabled()
    })

    it("should show submitting label when isSubmitting is true", () => {
      render(<MessageComposer {...defaultProps} isSubmitting={true} submittingLabel="Creating..." />)

      expect(screen.getByRole("button", { name: /creating/i })).toBeInTheDocument()
    })

    it("should show tooltip when hasFailed is true", () => {
      render(<MessageComposer {...defaultProps} hasFailed={true} />)

      const button = screen.getByRole("button", { name: /send/i })
      expect(button).toBeDisabled()
    })
  })

  describe("disabled state", () => {
    it("should disable editor when disabled is true", () => {
      render(<MessageComposer {...defaultProps} disabled={true} />)

      expect(screen.getByTestId("rich-editor")).toBeDisabled()
    })

    it("should disable upload button when disabled is true", () => {
      render(<MessageComposer {...defaultProps} disabled={true} />)

      expect(screen.getByRole("button", { name: /attach files/i })).toBeDisabled()
    })

    it("should keep editor editable when isSubmitting is true (prevents mobile keyboard close)", () => {
      render(<MessageComposer {...defaultProps} isSubmitting={true} />)

      expect(screen.getByTestId("rich-editor")).not.toBeDisabled()
    })
  })

  describe("interactions", () => {
    it("should call onContentChange when typing", async () => {
      const onContentChange = vi.fn()
      render(<MessageComposer {...defaultProps} onContentChange={onContentChange} />)

      const editor = screen.getByTestId("rich-editor")
      await userEvent.type(editor, "H")

      expect(onContentChange).toHaveBeenCalled()
      expect(onContentChange).toHaveBeenCalledWith(expect.objectContaining({ type: "doc" }))
    })

    it("should call onSubmit when submit button is clicked", async () => {
      const onSubmit = vi.fn()
      render(<MessageComposer {...defaultProps} onSubmit={onSubmit} canSubmit={true} />)

      const button = screen.getByRole("button", { name: /send/i })
      await userEvent.click(button)

      expect(onSubmit).toHaveBeenCalled()
    })
  })

  describe("attachments", () => {
    it("should render pending attachments", () => {
      const attachments: PendingAttachment[] = [
        { id: "attach_1", filename: "test.txt", mimeType: "text/plain", sizeBytes: 1024, status: "uploaded" },
      ]

      render(<MessageComposer {...defaultProps} pendingAttachments={attachments} />)

      expect(screen.getByText("test.txt")).toBeInTheDocument()
    })

    it("should not render attachments section when empty", () => {
      render(<MessageComposer {...defaultProps} pendingAttachments={[]} />)

      expect(screen.queryByText(/\.txt$/)).not.toBeInTheDocument()
    })

    it("inserts picked files at the editor selection by default on mobile", async () => {
      isMobileMockValue = true
      vi.spyOn(contextsModule, "usePreferencesOptional").mockReturnValue({
        preferences: {},
      } as unknown as ReturnType<typeof contextsModule.usePreferencesOptional>)
      const onFileSelect = vi.fn()
      const { container } = render(<MessageComposer {...defaultProps} onFileSelect={onFileSelect} />)
      const file = new File(["notes"], "notes.txt", { type: "text/plain" })

      await userEvent.upload(container.querySelector('input[type="file"]') as HTMLInputElement, file)

      expect(mockInsertFiles).toHaveBeenCalledWith([file])
      expect(onFileSelect).not.toHaveBeenCalled()
    })

    it("keeps the attachment-row flow when inline insertion is disabled", async () => {
      isMobileMockValue = true
      vi.spyOn(contextsModule, "usePreferencesOptional").mockReturnValue({
        preferences: { mobileInlineAttachments: false },
      } as unknown as ReturnType<typeof contextsModule.usePreferencesOptional>)
      const onFileSelect = vi.fn()
      const { container } = render(<MessageComposer {...defaultProps} onFileSelect={onFileSelect} />)
      const file = new File(["notes"], "notes.txt", { type: "text/plain" })

      await userEvent.upload(container.querySelector('input[type="file"]') as HTMLInputElement, file)

      expect({
        selectedFiles: Array.from(onFileSelect.mock.calls[0]?.[0].target.files ?? []),
        inlineInsertCalls: mockInsertFiles.mock.calls,
      }).toEqual({ selectedFiles: [file], inlineInsertCalls: [] })
    })
  })

  describe("collapsed composer action side", () => {
    // The collapsed row renders its own Send button rather than going through
    // EditorActionBar (which this suite mocks), so it needs mirroring of its
    // own — it was the one surface the original change missed.
    function collapsedRow(side: "left" | "right") {
      isMobileMockValue = true
      vi.spyOn(contextsModule, "usePreferencesOptional").mockReturnValue({
        preferences: { accessibility: { composerActionSide: side } },
      } as unknown as ReturnType<typeof contextsModule.usePreferencesOptional>)

      render(<MessageComposer {...defaultProps} placeholder="Write a reply..." />)
      return screen.getByText("Write a reply...").parentElement
    }

    it("keeps Send trailing the preview by default", () => {
      expect(collapsedRow("right")).not.toHaveClass("flex-row-reverse")
    })

    it("mirrors so Send leads the preview", () => {
      expect(collapsedRow("left")).toHaveClass("flex-row-reverse")
    })
  })

  describe("mobile state handling", () => {
    it("shows a slash command in the collapsed preview", () => {
      isMobileMockValue = true

      render(
        <MessageComposer
          {...defaultProps}
          content={{
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "slashCommand", attrs: { name: "steer", clientActionId: null } },
                  { type: "text", text: " focus on tests" },
                ],
              },
            ],
          }}
        />
      )

      expect(screen.getByText("/steer focus on tests")).toBeInTheDocument()
    })

    it("reports chrome closure after focus leaves", () => {
      isMobileMockValue = true
      vi.useFakeTimers()
      const onMobileChromeOpenChange = vi.fn()

      render(<MessageComposer {...defaultProps} onMobileChromeOpenChange={onMobileChromeOpenChange} />)
      expect(onMobileChromeOpenChange).toHaveBeenLastCalledWith(false)

      fireEvent.click(screen.getByTestId("rich-editor-wrapper"))
      expect(onMobileChromeOpenChange).toHaveBeenLastCalledWith(true)

      fireEvent.blur(screen.getByTestId("rich-editor"))
      act(() => vi.advanceTimersByTime(200))
      expect(onMobileChromeOpenChange).toHaveBeenLastCalledWith(false)
    })

    it("renders editor in preview mode when mobile unfocused with content", () => {
      isMobileMockValue = true

      const nestedDoc: JSONContent = {
        type: "doc",
        content: [
          {
            type: "bulletList",
            content: [
              {
                type: "listItem",
                content: [{ type: "paragraph", content: [{ type: "text", text: "First item" }] }],
              },
            ],
          },
        ],
      }

      render(<MessageComposer {...defaultProps} content={nestedDoc} />)

      // Editor is rendered (not hidden) — CSS clips it to single-line preview
      expect(screen.getByTestId("rich-editor")).toBeInTheDocument()
      expect(screen.queryByRole("button", { name: "Formatting" })).not.toBeInTheDocument()
    })

    it("resets mobile focus state when scope changes", () => {
      isMobileMockValue = true

      const { rerender } = render(<MessageComposer {...defaultProps} scopeId="scope-a" />)

      expect(screen.queryByRole("button", { name: "Formatting" })).not.toBeInTheDocument()

      // Click editor area to focus (not the textarea itself, which the guard skips)
      fireEvent.click(screen.getByTestId("rich-editor-wrapper"))
      expect(screen.getByRole("button", { name: "Formatting" })).toBeInTheDocument()

      rerender(<MessageComposer {...defaultProps} scopeId="scope-b" />)
      expect(screen.queryByRole("button", { name: "Formatting" })).not.toBeInTheDocument()
    })

    it("reveals the mobile chrome when typing reaches the collapsed (hidden) editor", () => {
      isMobileMockValue = true

      render(<MessageComposer {...defaultProps} />)

      // Collapsed resting state — no action bar.
      expect(screen.queryByRole("button", { name: "Formatting" })).not.toBeInTheDocument()

      // The editor stays mounted at zero height while collapsed, and a race
      // (stream switch without blur) can leave it focused. Typing evidence
      // must open the chrome, not feed a hidden editor with a broken caret.
      fireEvent(screen.getByTestId("rich-editor"), new InputEvent("beforeinput", { bubbles: true }))

      expect(screen.getByRole("button", { name: "Formatting" })).toBeInTheDocument()
      // The caret is left where it was — no focus("end") jump.
      expect(mockRichEditorFocus).not.toHaveBeenCalled()
    })

    it("reveals the mobile chrome when IME composition starts in the collapsed editor", () => {
      isMobileMockValue = true

      render(<MessageComposer {...defaultProps} />)

      fireEvent.compositionStart(screen.getByTestId("rich-editor"))

      expect(screen.getByRole("button", { name: "Formatting" })).toBeInTheDocument()
      expect(mockRichEditorFocus).not.toHaveBeenCalled()
    })

    it("closes mobile formatting toolbar on blur", () => {
      isMobileMockValue = true
      vi.useFakeTimers()

      render(<MessageComposer {...defaultProps} />)

      fireEvent.click(screen.getByTestId("rich-editor-wrapper"))

      const formatButton = screen.getByRole("button", { name: "Formatting" })
      fireEvent.click(formatButton)
      expect(screen.getByTestId("mobile-editor-toolbar")).toBeInTheDocument()

      fireEvent.blur(screen.getByTestId("rich-editor"))
      act(() => {
        vi.advanceTimersByTime(200)
      })

      expect(screen.queryByTestId("mobile-editor-toolbar")).not.toBeInTheDocument()
    })

    it("updates mobile toolbar editor when editor instance becomes available asynchronously", () => {
      isMobileMockValue = true
      vi.useFakeTimers()

      render(<MessageComposer {...defaultProps} />)

      fireEvent.click(screen.getByTestId("rich-editor-wrapper"))
      fireEvent.click(screen.getByRole("button", { name: "Formatting" }))

      expect(screen.getByTestId("mobile-editor-toolbar")).toHaveAttribute("data-has-editor", "no")

      act(() => {
        vi.advanceTimersByTime(10)
      })

      expect(screen.getByTestId("mobile-editor-toolbar")).toHaveAttribute("data-has-editor", "yes")
    })

    it("shows mobile indent controls in the formatting toolbar", () => {
      isMobileMockValue = true

      render(<MessageComposer {...defaultProps} />)

      fireEvent.click(screen.getByTestId("rich-editor-wrapper"))
      fireEvent.click(screen.getByRole("button", { name: "Formatting" }))

      expect(screen.getByTestId("mobile-editor-toolbar")).toHaveAttribute("data-has-special-input-controls", "yes")
      expect(screen.getByRole("button", { name: "Indent" })).toBeInTheDocument()
      expect(screen.getByRole("button", { name: "Dedent" })).toBeInTheDocument()
    })

    it("keeps the attachment tray mounted across a mobile chrome toggle, so a chip tap still activates", () => {
      isMobileMockValue = true
      let trayMounts = 0
      const activate = vi.fn()
      const MockTray = () => {
        useEffect(() => {
          trayMounts += 1
        }, [])
        return (
          <button type="button" data-testid="tray-chip" onClick={activate}>
            screenshot.png
          </button>
        )
      }
      spyOnExport(pendingAttachmentsModule, "PendingAttachments").mockReturnValue(
        MockTray as unknown as typeof pendingAttachmentsModule.PendingAttachments
      )
      const attachments: PendingAttachment[] = [
        { id: "att_1", filename: "screenshot.png", mimeType: "image/png", sizeBytes: 2048, status: "uploaded" },
      ]

      const onMobileChromeOpenChange = vi.fn()
      render(
        <MessageComposer
          {...defaultProps}
          pendingAttachments={attachments}
          onMobileChromeOpenChange={onMobileChromeOpenChange}
        />
      )
      expect(trayMounts).toBe(1)
      expect(onMobileChromeOpenChange).toHaveBeenLastCalledWith(false)

      // Tapping a chip focuses it, which opens the mobile chrome. The tray must
      // keep its one React position through that: a remount tears the chip down
      // before its click lands (and drops the tray's own preview state).
      const chip = screen.getByTestId("tray-chip")
      fireEvent.focus(chip)
      fireEvent.click(chip)

      expect(onMobileChromeOpenChange).toHaveBeenLastCalledWith(true)
      expect(trayMounts).toBe(1)
      expect(activate).toHaveBeenCalledTimes(1)
      expect(screen.getByTestId("tray-chip")).toBe(chip)
    })
  })

  describe("stash shortcut (Cmd/Ctrl+S)", () => {
    const draft: CachedDraft = {
      id: "draft_1",
      workspaceId: "ws_1",
      scope: "stream:stream_1",
      contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "stashed body" }] }] },
      attachments: [],
      clientUpdatedAt: Date.now(),
    }

    function renderWithPicker(props: Partial<Parameters<typeof MessageComposer>[0]> = {}) {
      const onStashDraft = vi.fn()
      const onRestore = vi.fn()
      render(
        <MemoryRouter>
          <MessageComposer
            {...defaultProps}
            onStashDraft={onStashDraft}
            stashedDrafts={{
              drafts: [draft],
              canStashCurrent: false,
              onStashCurrent: vi.fn(),
              onRestore,
              onDelete: vi.fn(),
            }}
            {...props}
          />
        </MemoryRouter>
      )
      return { onStashDraft, onRestore }
    }

    it("opens the drafts picker instead of stashing when the composer is empty", async () => {
      const { onStashDraft } = renderWithPicker({ content: EMPTY_DOC })

      fireEvent.keyDown(screen.getByTestId("rich-editor"), { key: "s", metaKey: true })

      expect(await screen.findByText("stashed body")).toBeInTheDocument()
      expect(onStashDraft).not.toHaveBeenCalled()
    })

    it("stashes (and does not open the picker) when the composer has content", () => {
      const { onStashDraft } = renderWithPicker({
        content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "wip" }] }] },
      })

      fireEvent.keyDown(screen.getByTestId("rich-editor"), { key: "s", metaKey: true })

      expect(onStashDraft).toHaveBeenCalledOnce()
      expect(screen.queryByText("stashed body")).not.toBeInTheDocument()
    })
  })
})
