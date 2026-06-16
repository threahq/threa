import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { DocumentEditorModal } from "./document-editor-modal"
import * as mentionablesModule from "@/hooks/use-mentionables"
import * as workspaceEmojiModule from "@/hooks/use-workspace-emoji"
import * as contextsModule from "@/contexts"
import * as triggersModule from "./triggers"

const mockPreferences = {
  keyboardShortcuts: {} as Record<string, string>,
}

function renderWithRouter(ui: React.ReactElement) {
  return render(
    <MemoryRouter initialEntries={["/w/ws_123"]}>
      <Routes>
        <Route path="/w/:workspaceId" element={ui} />
      </Routes>
    </MemoryRouter>
  )
}

describe("DocumentEditorModal", () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    onSend: vi.fn(),
    streamName: "Test Stream",
  }

  beforeEach(() => {
    vi.restoreAllMocks()
    mockPreferences.keyboardShortcuts = {}
    vi.spyOn(mentionablesModule, "useMentionables").mockReturnValue({
      mentionables: [],
    } as unknown as ReturnType<typeof mentionablesModule.useMentionables>)
    vi.spyOn(workspaceEmojiModule, "useWorkspaceEmoji").mockReturnValue({
      emojis: [],
      emojiWeights: new Map(),
      toEmoji: () => null,
    } as unknown as ReturnType<typeof workspaceEmojiModule.useWorkspaceEmoji>)
    vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
      preferences: mockPreferences,
      isLoading: false,
    } as unknown as ReturnType<typeof contextsModule.usePreferences>)
    vi.spyOn(triggersModule, "useMentionSuggestion").mockReturnValue({
      suggestionConfig: null,
      renderMentionList: () => null,
    } as unknown as ReturnType<typeof triggersModule.useMentionSuggestion>)
    vi.spyOn(triggersModule, "useChannelSuggestion").mockReturnValue({
      suggestionConfig: null,
      renderChannelList: () => null,
    } as unknown as ReturnType<typeof triggersModule.useChannelSuggestion>)
    vi.spyOn(triggersModule, "useEmojiSuggestion").mockReturnValue({
      suggestionConfig: null,
      renderEmojiGrid: () => null,
    } as unknown as ReturnType<typeof triggersModule.useEmojiSuggestion>)
  })

  describe("rendering", () => {
    it("should render the modal when open", () => {
      renderWithRouter(<DocumentEditorModal {...defaultProps} />)

      expect(screen.getByText("Test Stream")).toBeInTheDocument()
      expect(screen.getByText(/Message in/)).toBeInTheDocument()
    })

    it("should not render when closed", () => {
      renderWithRouter(<DocumentEditorModal {...defaultProps} open={false} />)

      expect(screen.queryByText("Test Stream")).not.toBeInTheDocument()
    })

    it("should render the toolbar with formatting buttons", () => {
      renderWithRouter(<DocumentEditorModal {...defaultProps} />)

      expect(screen.getByRole("button", { name: "Bold" })).toBeInTheDocument()
      expect(screen.getByRole("button", { name: "Italic" })).toBeInTheDocument()
      expect(screen.getByRole("button", { name: "Strikethrough" })).toBeInTheDocument()
      expect(screen.getByRole("button", { name: "Inline code" })).toBeInTheDocument()
      expect(screen.getByRole("button", { name: "Link" })).toBeInTheDocument()
      expect(screen.getByRole("button", { name: "Quote" })).toBeInTheDocument()
      expect(screen.getByRole("button", { name: "Bullet list" })).toBeInTheDocument()
      expect(screen.getByRole("button", { name: "Numbered list" })).toBeInTheDocument()
      expect(screen.getByRole("button", { name: "Code block" })).toBeInTheDocument()
    })

    it("should render heading buttons", () => {
      renderWithRouter(<DocumentEditorModal {...defaultProps} />)

      expect(screen.getByRole("button", { name: "Heading 1" })).toBeInTheDocument()
      expect(screen.getByRole("button", { name: "Heading 2" })).toBeInTheDocument()
      expect(screen.getByRole("button", { name: "Heading 3" })).toBeInTheDocument()
    })

    it("should render Send and Cancel buttons", () => {
      renderWithRouter(<DocumentEditorModal {...defaultProps} />)

      expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument()
      expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument()
    })

    it("should show keyboard hint for sending", () => {
      renderWithRouter(<DocumentEditorModal {...defaultProps} />)

      expect(screen.getByText(/to send/)).toBeInTheDocument()
    })

    it("should omit formatting hints that are disabled by a conflicting global shortcut", async () => {
      const user = userEvent.setup()
      mockPreferences.keyboardShortcuts = { toggleSidebar: "mod+b" }

      renderWithRouter(<DocumentEditorModal {...defaultProps} />)

      await user.hover(screen.getByRole("button", { name: "Bold" }))

      expect((await screen.findAllByText("Bold")).length).toBeGreaterThan(0)
      expect(screen.queryByText(/^Ctrl\+B$|^⌘B$/)).not.toBeInTheDocument()
    })
  })

  describe("interactions", () => {
    it("should call onOpenChange when Cancel is clicked", async () => {
      const user = userEvent.setup()
      const onOpenChange = vi.fn()

      renderWithRouter(<DocumentEditorModal {...defaultProps} onOpenChange={onOpenChange} />)

      await user.click(screen.getByRole("button", { name: "Cancel" }))

      expect(onOpenChange).toHaveBeenCalledWith(false)
    })

    it("should disable Send button when content is empty", () => {
      renderWithRouter(<DocumentEditorModal {...defaultProps} initialContent="" />)

      const sendButton = screen.getByRole("button", { name: "Send" })
      expect(sendButton).toBeDisabled()
    })

    it("should not reset editor content when initialContent prop changes while modal is already open", () => {
      const { rerender } = render(
        <MemoryRouter initialEntries={["/w/ws_123"]}>
          <Routes>
            <Route
              path="/w/:workspaceId"
              element={<DocumentEditorModal {...defaultProps} initialContent="Hello World" />}
            />
          </Routes>
        </MemoryRouter>
      )

      expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled()

      // Parent updates initialContent to empty while the modal stays open
      rerender(
        <MemoryRouter initialEntries={["/w/ws_123"]}>
          <Routes>
            <Route path="/w/:workspaceId" element={<DocumentEditorModal {...defaultProps} initialContent="" />} />
          </Routes>
        </MemoryRouter>
      )

      // Send must still be enabled: the editor was not reset to the new (empty) initialContent
      expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled()
    })
  })
})
