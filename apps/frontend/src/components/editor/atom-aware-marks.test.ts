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

describe("editor formatting input rules", () => {
  it.each([
    { input: "*italic text*", selector: "em", mark: "italic", text: "italic text", delimiter: "*italic" },
    { input: "~~struck text~~", selector: "s", mark: "strike", text: "struck text", delimiter: "~~" },
    { input: "`inline code`", selector: "code", mark: "code", text: "inline code", delimiter: "`inline" },
  ])("should convert $input through the installed mark input rule", ({ input, selector, mark, text, delimiter }) => {
    const editor = createTestEditor()

    typeText(editor, input)

    expect(editor.getJSON().content?.[0]?.content?.[0]).toMatchObject({
      type: "text",
      text,
      marks: [{ type: mark }],
    })
    expect(editor.view.dom.querySelector(selector)?.textContent).toBe(text)
    expect(editor.view.dom.textContent).not.toContain(delimiter)
    expect(serializeToMarkdown(editor.getJSON())).toBe(input)
  })

  it.each([
    { input: "## Heading Two", selector: "h2", level: 2, text: "Heading Two" },
    { input: "### Heading Three", selector: "h3", level: 3, text: "Heading Three" },
  ])(
    "should convert the level-$level prefix through the installed heading input rule",
    ({ input, selector, level, text }) => {
      const editor = createTestEditor()

      typeText(editor, input)

      expect(editor.getJSON().content?.[0]).toMatchObject({ type: "heading", attrs: { level }, content: [{ text }] })
      expect(editor.view.dom.querySelector(selector)?.textContent).toBe(text)
      expect(editor.view.dom.textContent).not.toContain("#")
    }
  )

  it("should convert the numbered-list prefix through the installed list input rule", () => {
    const editor = createTestEditor()

    typeText(editor, "1. first item")

    expect(editor.getJSON().content?.[0]).toMatchObject({
      type: "orderedList",
      content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ text: "first item" }] }] }],
    })
    expect(editor.view.dom.querySelector("ol li")?.textContent).toBe("first item")
    expect(editor.view.dom.textContent).not.toContain("1. ")
  })
})
