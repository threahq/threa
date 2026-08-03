import { afterEach, describe, expect, it, vi } from "vitest"
import { Editor } from "@tiptap/core"
import { createEditorExtensions } from "./editor-extensions"
import { parseMarkdown, serializeToMarkdown } from "./editor-markdown"
import { handleBeforeInputLinkPaste, pasteLinkOverSelection } from "./paste-link-over-selection"

const openEditors: Editor[] = []

afterEach(() => {
  while (openEditors.length > 0) openEditors.pop()?.destroy()
})

function createTestEditor(markdown: string): Editor {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: createEditorExtensions({
      placeholder: "Type a message...",
      mentionSuggestion: {
        items: () => [],
        render: () => ({ onStart: () => {}, onUpdate: () => {}, onExit: () => {}, onKeyDown: () => false }),
      },
    }),
    content: parseMarkdown(markdown),
  })
  openEditors.push(editor)
  return editor
}

function selectText(editor: Editor, text: string): void {
  let range: { from: number; to: number } | null = null
  editor.state.doc.descendants((node, pos) => {
    const index = node.isText ? (node.text ?? "").indexOf(text) : -1
    if (index === -1) return true
    range = { from: pos + index, to: pos + index + text.length }
    return false
  })
  if (!range) throw new Error(`Text not found: ${text}`)
  editor.commands.setTextSelection(range)
}

describe("pasteLinkOverSelection", () => {
  it("turns selected text into a link without replacing it or dropping its marks", () => {
    const editor = createTestEditor("Read **the docs** today")
    selectText(editor, "the docs")

    expect(pasteLinkOverSelection(editor, "https://example.com/docs")).toBe(true)
    expect(serializeToMarkdown(editor.getJSON())).toBe("Read **[the docs](https://example.com/docs)** today")
  })

  it("links a mixed inline-code selection as one phrase by dropping the incompatible code mark", () => {
    const editor = createTestEditor("plain `code` tail")
    editor.commands.setTextSelection({ from: 1, to: editor.state.doc.content.size - 1 })

    expect(pasteLinkOverSelection(editor, "https://example.com")).toBe(true)
    expect(serializeToMarkdown(editor.getJSON())).toBe("[plain code tail](https://example.com)")
  })

  it("declines selections containing inline atoms instead of creating nested links", () => {
    const editor = createTestEditor("ask [@alice](user:usr_01) docs")
    editor.commands.setTextSelection({ from: 1, to: editor.state.doc.content.size - 1 })

    expect(pasteLinkOverSelection(editor, "https://example.com")).toBe(false)
    expect(serializeToMarkdown(editor.getJSON())).toBe("ask [@alice](user:usr_01) docs")
  })

  it("normalizes bare domains and email addresses without misclassifying URLs with userinfo", () => {
    const domainEditor = createTestEditor("the website")
    selectText(domainEditor, "website")
    expect(pasteLinkOverSelection(domainEditor, "example.com/path")).toBe(true)
    expect(serializeToMarkdown(domainEditor.getJSON())).toBe("the [website](http://example.com/path)")

    const emailEditor = createTestEditor("email support")
    selectText(emailEditor, "support")
    expect(pasteLinkOverSelection(emailEditor, "help@example.com")).toBe(true)
    expect(serializeToMarkdown(emailEditor.getJSON())).toBe("email [support](mailto:help@example.com)")

    const userInfoEditor = createTestEditor("private site")
    selectText(userInfoEditor, "site")
    expect(pasteLinkOverSelection(userInfoEditor, "https://user@example.com")).toBe(true)
    expect(serializeToMarkdown(userInfoEditor.getJSON())).toBe("private [site](https://user@example.com)")
  })

  it("leaves the paste path alone without selected text or a valid safe link", () => {
    const editor = createTestEditor("keep this text")
    editor.commands.focus("end")

    expect(pasteLinkOverSelection(editor, "https://example.com")).toBe(false)

    selectText(editor, "this")
    expect(pasteLinkOverSelection(editor, "not a link")).toBe(false)
    expect(pasteLinkOverSelection(editor, "javascript:alert(1)")).toBe(false)
    expect(pasteLinkOverSelection(editor, "example..com")).toBe(false)
    expect(pasteLinkOverSelection(editor, "example.com,")).toBe(false)
    expect(pasteLinkOverSelection(editor, "https://example..com")).toBe(false)
    expect(pasteLinkOverSelection(editor, "https://-example.com")).toBe(false)
    expect(pasteLinkOverSelection(editor, "https://%zz.com")).toBe(false)
    expect(pasteLinkOverSelection(editor, "https://example.com:99999")).toBe(false)
    expect(serializeToMarkdown(editor.getJSON())).toBe("keep this text")
  })
})

describe("handleBeforeInputLinkPaste", () => {
  function event(inputType: string, data: string | null, dataTransferText = "", collapsed = true) {
    return {
      inputType,
      data,
      dataTransfer: dataTransferText ? { getData: () => dataTransferText } : null,
      getTargetRanges: () => [{ collapsed }],
      preventDefault: vi.fn(),
    } as unknown as InputEvent & { preventDefault: ReturnType<typeof vi.fn> }
  }

  it.each([
    ["insertText", "https://example.com", "", true],
    ["insertFromPaste", "https://example.com", "", true],
    ["insertFromPaste", null, "https://example.com", true],
    ["insertReplacementText", "https://example.com", "", false],
  ])("links selected text for %s beforeinput events", (inputType, data, dataTransferText, collapsed) => {
    const editor = createTestEditor("selected text")
    selectText(editor, "selected")
    const inputEvent = event(inputType, data, dataTransferText, collapsed)

    expect(handleBeforeInputLinkPaste(editor, inputEvent)).toBe(true)
    expect(inputEvent.preventDefault).toHaveBeenCalledOnce()
    expect(serializeToMarkdown(editor.getJSON())).toBe("[selected](https://example.com) text")
  })

  it("leaves spellcheck replacement ranges to the browser when the editor selection is collapsed", () => {
    const editor = createTestEditor("selected text")
    editor.commands.focus("end")
    const inputEvent = event("insertReplacementText", "https://example.com", "", false)

    expect(handleBeforeInputLinkPaste(editor, inputEvent)).toBe(false)
    expect(inputEvent.preventDefault).not.toHaveBeenCalled()
    expect(serializeToMarkdown(editor.getJSON())).toBe("selected text")
  })
})
