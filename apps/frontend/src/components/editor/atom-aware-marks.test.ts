import { afterEach, describe, expect, it } from "vitest"
import { Editor } from "@tiptap/core"
import { createEditorExtensions } from "./editor-extensions"
import { parseMarkdown, serializeToMarkdown } from "./editor-markdown"

const openEditors: Editor[] = []

afterEach(() => {
  while (openEditors.length > 0) openEditors.pop()?.destroy()
})

function createTestEditor(markdown = ""): Editor {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: createEditorExtensions({ placeholder: "Type a message..." }),
    content: parseMarkdown(markdown),
  })
  openEditors.push(editor)
  return editor
}

function typeText(editor: Editor, text: string): void {
  for (const char of text) {
    const { from, to } = editor.state.selection
    const handled = editor.view.someProp("handleTextInput", (handler) =>
      handler(editor.view, from, to, char, () => editor.state.tr.insertText(char, from, to))
    )
    if (!handled) editor.view.dispatch(editor.state.tr.insertText(char, from, to))
  }
}

describe("AtomAwareCode", () => {
  it("should send a URL as code text when backticks close around it after it autolinked", () => {
    const editor = createTestEditor()

    typeText(editor, "run `curl https://x.com/a -v` now")

    expect(serializeToMarkdown(editor.getJSON())).toBe("run `curl https://x.com/a -v` now")
  })

  it("should drop the link when code is toggled on over linked text", () => {
    const editor = createTestEditor("see [site](https://x.io) now")
    editor.commands.setTextSelection({ from: 5, to: 9 })

    editor.commands.toggleCode()

    expect(serializeToMarkdown(editor.getJSON())).toBe("see `site` now")
  })

  it("should keep a link that is added onto existing code", () => {
    const editor = createTestEditor("see `site` now")
    editor.commands.setTextSelection({ from: 5, to: 9 })

    editor.commands.setLink({ href: "https://x.io" })

    expect(serializeToMarkdown(editor.getJSON())).toBe("see [`site`](https://x.io) now")
  })
})
