import { useState } from "react"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { Editor } from "@tiptap/react"
import { EditorToolbar } from "./editor-toolbar"
import * as editorBehaviors from "./editor-behaviors"
import * as contextsModule from "@/contexts"

const mockPreferences = {
  keyboardShortcuts: {} as Record<string, string>,
}

function createEditorStub() {
  const chain = {
    focus: vi.fn(() => chain),
    toggleBold: vi.fn(() => chain),
    toggleItalic: vi.fn(() => chain),
    toggleStrike: vi.fn(() => chain),
    toggleCode: vi.fn(() => chain),
    toggleBlockquote: vi.fn(() => chain),
    toggleBulletList: vi.fn(() => chain),
    toggleOrderedList: vi.fn(() => chain),
    toggleCodeBlock: vi.fn(() => chain),
    toggleHeading: vi.fn(() => chain),
    setParagraph: vi.fn(() => chain),
    addRowBefore: vi.fn(() => chain),
    addRowAfter: vi.fn(() => chain),
    addColumnBefore: vi.fn(() => chain),
    addColumnAfter: vi.fn(() => chain),
    deleteRow: vi.fn(() => chain),
    deleteColumn: vi.fn(() => chain),
    deleteTable: vi.fn(() => chain),
    insertTable: vi.fn(() => chain),
    run: vi.fn(() => true),
  }

  return {
    isActive: vi.fn(() => false),
    getAttributes: vi.fn(() => ({ href: "https://example.com" })),
    state: {
      selection: {
        from: 1,
        to: 4,
      },
    },
    chain: vi.fn(() => chain),
    commands: {
      focus: vi.fn(),
    },
    on: vi.fn(),
    off: vi.fn(),
    __chainState: chain,
    __run: chain.run,
  } as unknown as Editor
}

function ToolbarHarness({ editor }: { editor: Editor }) {
  const [linkPopoverOpen, setLinkPopoverOpen] = useState(false)

  return (
    <EditorToolbar
      editor={editor}
      isVisible
      linkPopoverOpen={linkPopoverOpen}
      onLinkPopoverOpenChange={setLinkPopoverOpen}
    />
  )
}

describe("EditorToolbar", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mockPreferences.keyboardShortcuts = {}
    vi.spyOn(editorBehaviors, "indentSelection").mockImplementation(() => false)
    vi.spyOn(editorBehaviors, "dedentSelection").mockImplementation(() => false)
    vi.spyOn(editorBehaviors, "handleLinkToolbarAction").mockImplementation(() => "opened")
    vi.spyOn(editorBehaviors, "isSuggestionActive").mockImplementation(() => false)
    vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
      preferences: mockPreferences,
      isLoading: false,
    } as unknown as ReturnType<typeof contextsModule.usePreferences>)
  })

  it("keeps inline formatting buttons in the tab order", async () => {
    const user = userEvent.setup()
    const editor = createEditorStub() as Editor & {
      __chainState: { focus: ReturnType<typeof vi.fn>; toggleBold: ReturnType<typeof vi.fn> }
      __run: ReturnType<typeof vi.fn>
    }

    render(<EditorToolbar editor={editor} isVisible inline />)

    await user.tab()
    await user.tab()

    expect(screen.getByRole("button", { name: "Bold" })).toHaveFocus()
  })

  it("supports keyboard activation for inline formatting buttons", async () => {
    const user = userEvent.setup()
    const editor = createEditorStub() as Editor & {
      __chainState: { focus: ReturnType<typeof vi.fn>; toggleBold: ReturnType<typeof vi.fn> }
      __run: ReturnType<typeof vi.fn>
    }

    render(<EditorToolbar editor={editor} isVisible inline />)

    await user.tab()
    await user.tab()
    await user.keyboard("{Enter}")

    expect(editor.__chainState.focus).toHaveBeenCalled()
    expect(editor.__chainState.toggleBold).toHaveBeenCalled()
    expect(editor.__run).toHaveBeenCalled()
  })

  it("supports pointer activation for inline formatting buttons", async () => {
    const user = userEvent.setup()
    const editor = createEditorStub() as Editor & {
      __chainState: { focus: ReturnType<typeof vi.fn>; toggleBold: ReturnType<typeof vi.fn> }
      __run: ReturnType<typeof vi.fn>
    }

    render(<EditorToolbar editor={editor} isVisible inline />)

    await user.click(screen.getByRole("button", { name: "Bold" }))

    expect(editor.__chainState.focus).toHaveBeenCalled()
    expect(editor.__chainState.toggleBold).toHaveBeenCalled()
    expect(editor.__run).toHaveBeenCalled()
  })

  it("omits dead shortcut hints when a global shortcut claims the editor binding", async () => {
    const user = userEvent.setup()
    mockPreferences.keyboardShortcuts = { toggleSidebar: "mod+b" }
    const editor = createEditorStub()

    render(<EditorToolbar editor={editor} isVisible />)

    await user.hover(screen.getByRole("button", { name: "Bold" }))

    expect((await screen.findAllByText("Bold")).length).toBeGreaterThan(0)
    expect(screen.queryByText(/^Ctrl\+B$|^⌘B$/)).not.toBeInTheDocument()
  })

  it("routes the link button through the shared link toolbar action", async () => {
    const user = userEvent.setup()
    const editor = createEditorStub()

    render(<EditorToolbar editor={editor} isVisible inline />)

    await user.click(screen.getByRole("button", { name: "Link" }))

    expect(editorBehaviors.handleLinkToolbarAction).toHaveBeenCalledWith(editor, false, undefined)
  })

  it("defers the link action until click so opening the editor does not race the click sequence", () => {
    const editor = createEditorStub()

    render(<EditorToolbar editor={editor} isVisible inline />)

    fireEvent.pointerDown(screen.getByRole("button", { name: "Link" }))
    expect(editorBehaviors.handleLinkToolbarAction).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Link" }))
    expect(editorBehaviors.handleLinkToolbarAction).toHaveBeenCalledWith(editor, false, undefined)
  })

  it("keeps the initially selected link URL after the editor selection changes", async () => {
    const user = userEvent.setup()
    const editor = createEditorStub()
    vi.mocked(editorBehaviors.handleLinkToolbarAction).mockImplementation((_editor, _open, onLinkPopoverOpenChange) => {
      onLinkPopoverOpenChange?.(true)
      return "opened"
    })

    const { rerender } = render(<ToolbarHarness editor={editor} />)

    await user.click(screen.getByRole("button", { name: "Link" }))
    expect(screen.getByDisplayValue("https://example.com")).toBeInTheDocument()

    vi.mocked(editor.getAttributes).mockReturnValue({ href: "" })
    rerender(<ToolbarHarness editor={editor} />)

    expect(screen.getByDisplayValue("https://example.com")).toBeInTheDocument()
  })

  it("focuses the link input when the floating link editor opens", () => {
    vi.useFakeTimers()
    const editor = createEditorStub()
    vi.mocked(editorBehaviors.handleLinkToolbarAction).mockImplementation((_editor, _open, onLinkPopoverOpenChange) => {
      onLinkPopoverOpenChange?.(true)
      return "opened"
    })

    try {
      render(<ToolbarHarness editor={editor} />)

      fireEvent.click(screen.getByRole("button", { name: "Link" }))
      act(() => vi.runAllTimers())

      expect(screen.getByDisplayValue("https://example.com")).toHaveFocus()
    } finally {
      vi.useRealTimers()
    }
  })

  it("closes the floating link editor on outside pointer interaction", () => {
    const editor = createEditorStub()
    const onLinkPopoverOpenChange = vi.fn()

    render(
      <EditorToolbar editor={editor} isVisible linkPopoverOpen onLinkPopoverOpenChange={onLinkPopoverOpenChange} />
    )

    fireEvent.pointerDown(document.body)

    expect(onLinkPopoverOpenChange).toHaveBeenCalledWith(false)
  })

  it("renders indent and dedent controls only when special input controls are enabled", () => {
    const editor = createEditorStub()
    const { rerender } = render(<EditorToolbar editor={editor} isVisible inline inlinePosition="below" />)

    expect(screen.queryByRole("button", { name: "Indent" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Dedent" })).not.toBeInTheDocument()

    rerender(<EditorToolbar editor={editor} isVisible inline inlinePosition="below" showSpecialInputControls />)

    expect(screen.getByRole("button", { name: "Indent" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Dedent" })).toBeInTheDocument()
  })

  it("dispatches shared indent and dedent commands from the mobile controls", () => {
    const editor = createEditorStub()
    render(<EditorToolbar editor={editor} isVisible inline inlinePosition="below" showSpecialInputControls />)

    fireEvent.pointerDown(screen.getByRole("button", { name: "Indent" }))
    fireEvent.pointerDown(screen.getByRole("button", { name: "Dedent" }))
    expect(editorBehaviors.indentSelection).not.toHaveBeenCalled()
    expect(editorBehaviors.dedentSelection).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Indent" }))
    fireEvent.click(screen.getByRole("button", { name: "Dedent" }))

    expect(editorBehaviors.indentSelection).toHaveBeenCalledWith(editor)
    expect(editorBehaviors.dedentSelection).toHaveBeenCalledWith(editor)
  })

  it("skips indent and dedent when a suggestion popup is active", () => {
    const editor = createEditorStub()
    vi.mocked(editorBehaviors.isSuggestionActive).mockReturnValue(true)
    render(<EditorToolbar editor={editor} isVisible inline inlinePosition="below" showSpecialInputControls />)

    fireEvent.click(screen.getByRole("button", { name: "Indent" }))
    fireEvent.click(screen.getByRole("button", { name: "Dedent" }))

    expect(editorBehaviors.indentSelection).not.toHaveBeenCalled()
    expect(editorBehaviors.dedentSelection).not.toHaveBeenCalled()
  })

  it("uses a dedicated scroll container for the mobile inline toolbar without the edge fade overlay", () => {
    const editor = createEditorStub()
    const { container } = render(
      <EditorToolbar editor={editor} isVisible inline inlinePosition="below" showSpecialInputControls />
    )

    expect(screen.getByTestId("mobile-inline-toolbar-scroll")).toBeInTheDocument()
    expect(container.querySelector(".bg-gradient-to-l")).toBeNull()
  })

  it("neutralizes ghost hover and uses active:bg-muted for mobile toolbar buttons", () => {
    const editor = createEditorStub()
    render(<EditorToolbar editor={editor} isVisible inline inlinePosition="below" showSpecialInputControls />)

    const boldButton = screen.getByRole("button", { name: "Bold" })
    expect(boldButton.className).toContain("active:bg-muted")
    expect(boldButton.className).toContain("hover:bg-transparent")
    expect(boldButton.className).not.toContain("hover:bg-muted")
  })

  it("preserves toggled-on background through hover for mobile toolbar buttons", () => {
    const editor = createEditorStub()
    vi.mocked(editor.isActive).mockImplementation((type) => type === "bold")
    render(<EditorToolbar editor={editor} isVisible inline inlinePosition="below" showSpecialInputControls />)

    const boldButton = screen.getByRole("button", { name: "Bold" })
    expect(boldButton.className).toContain("bg-muted-foreground/20")
    expect(boldButton.className).toContain("hover:bg-muted-foreground/20")
  })

  it("waits for click before running mobile table menu actions so the popover absorbs the touchend", async () => {
    const editor = createEditorStub()
    vi.mocked(editor.isActive).mockImplementation((type) => type === "table")
    const user = userEvent.setup()
    render(<EditorToolbar editor={editor} isVisible inline inlinePosition="below" />)

    await user.click(screen.getByRole("button", { name: "Edit table" }))

    const deleteTable = await screen
      .findByRole("menuitem", { name: /Delete table/ })
      .catch(() => screen.getByRole("button", { name: /Delete table/ }))

    // Mobile path: pointerdown on a menu item must NOT fire the action.
    // Acting on pointerdown closes the popover before the synthesized
    // touchend/click lands, which leaks the click through to whichever
    // toolbar button now sits under the user's finger.
    fireEvent.pointerDown(deleteTable)
    const chainStub = (editor as unknown as { __chainState: { deleteTable: ReturnType<typeof vi.fn> } }).__chainState
    expect(chainStub.deleteTable).not.toHaveBeenCalled()

    fireEvent.click(deleteTable)
    expect(chainStub.deleteTable).toHaveBeenCalled()
  })
})
