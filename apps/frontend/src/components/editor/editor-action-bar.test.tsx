import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TooltipProvider } from "@/components/ui/tooltip"
import { EditorActionBar } from "./editor-action-bar"

function renderBar(props: Partial<React.ComponentProps<typeof EditorActionBar>> = {}) {
  const editorHandle = {
    focus: vi.fn(),
    focusAfterQuoteReply: vi.fn(),
    insertMention: vi.fn(),
    insertSlash: vi.fn(),
    insertEmoji: vi.fn(),
    insertTranscribedText: vi.fn(),
    setDictationInterim: vi.fn(),
    insertDictationChunk: vi.fn(),
    replaceDictationChunkText: vi.fn(() => true),
    lockDictationChunk: vi.fn(),
    lockAllDictationChunks: vi.fn(),
    getEditor: vi.fn(() => null),
  }

  const onFormatOpenChange = vi.fn()
  const onMobileExpandedChange = vi.fn()
  const onDesktopExpandClick = vi.fn()

  render(
    <TooltipProvider>
      <EditorActionBar
        editorHandle={editorHandle}
        formatOpen={false}
        onFormatOpenChange={onFormatOpenChange}
        onMobileExpandedChange={onMobileExpandedChange}
        onDesktopExpandClick={onDesktopExpandClick}
        trailingContent={<button type="button">Send</button>}
        {...props}
      />
    </TooltipProvider>
  )

  return { editorHandle, onFormatOpenChange, onMobileExpandedChange, onDesktopExpandClick }
}

describe("EditorActionBar", () => {
  it("supports keyboard activation for the format toggle", async () => {
    const user = userEvent.setup()
    const { onFormatOpenChange } = renderBar({ showExpand: false, showAttach: false })

    const button = screen.getByRole("button", { name: "Formatting" })
    button.focus()
    await user.keyboard("{Enter}")

    expect(onFormatOpenChange).toHaveBeenCalledWith(true)
  })

  it("supports keyboard activation for insert mention", async () => {
    const user = userEvent.setup()
    const { editorHandle } = renderBar({ showExpand: false, showAttach: false })

    const button = screen.getByRole("button", { name: "Insert mention" })
    button.focus()
    await user.keyboard("{Enter}")

    expect(editorHandle.insertMention).toHaveBeenCalled()
  })

  it("supports pointer activation for mobile expand", async () => {
    const user = userEvent.setup()
    const { onMobileExpandedChange } = renderBar({ mobileExpanded: false, showAttach: false })

    await user.click(screen.getByRole("button", { name: "Expand editor" }))

    expect(onMobileExpandedChange).toHaveBeenCalledWith(true)
  })

  it("supports pointer activation for desktop expand", async () => {
    const user = userEvent.setup()
    const { onDesktopExpandClick } = renderBar({
      showExpand: false,
      showAttach: false,
      showDesktopExpand: true,
    })

    await user.click(screen.getByRole("button", { name: "Expand to fullscreen editor" }))

    expect(onDesktopExpandClick).toHaveBeenCalled()
  })
})
