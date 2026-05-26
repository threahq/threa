import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { spyOnExport } from "@/test/spy"
import { render, screen, fireEvent, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { forwardRef, useEffect, useImperativeHandle, useState } from "react"
import { MessageComposer } from "./message-composer"
import type { PendingAttachment } from "@/hooks/use-attachments"
import type { JSONContent } from "@threa/types"
import * as useMobileModule from "@/hooks/use-mobile"
import * as editorModule from "@/components/editor"

let isMobileMockValue = false

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
      focus: () => undefined,
      insertMention: () => undefined,
      insertSlash: () => undefined,
      insertEmoji: () => undefined,
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

  describe("rendering", () => {
    it("should render the editor", () => {
      render(<MessageComposer {...defaultProps} />)

      expect(screen.getByTestId("rich-editor")).toBeInTheDocument()
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

      // The button should be disabled with tooltip
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

      // Should have been called with JSONContent structure
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

      // No attachment chips should be visible
      expect(screen.queryByText(/\.txt$/)).not.toBeInTheDocument()
    })
  })

  describe("mobile state handling", () => {
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
      // Action bar is not rendered in unfocused state
      expect(screen.queryByRole("button", { name: "Formatting" })).not.toBeInTheDocument()
    })

    it("resets mobile focus state when scope changes", () => {
      isMobileMockValue = true

      const { rerender } = render(<MessageComposer {...defaultProps} scopeId="scope-a" />)

      // Initially unfocused — action bar not rendered
      expect(screen.queryByRole("button", { name: "Formatting" })).not.toBeInTheDocument()

      // Click editor area to focus (not the textarea itself, which the guard skips)
      fireEvent.click(screen.getByTestId("rich-editor-wrapper"))
      expect(screen.getByRole("button", { name: "Formatting" })).toBeInTheDocument()

      // Scope change resets to unfocused
      rerender(<MessageComposer {...defaultProps} scopeId="scope-b" />)
      expect(screen.queryByRole("button", { name: "Formatting" })).not.toBeInTheDocument()
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
  })
})
