import { afterEach, describe, expect, it } from "vitest"
import { Editor } from "@tiptap/core"
import { createEditorExtensions } from "./editor-extensions"
import { parseMarkdown } from "./editor-markdown"
import { insertPlainText, isPlainTextPaste, markdownToPlainText } from "./plain-text-paste"

/**
 * Editors are torn down after each test: a live view keeps a DOMObserver
 * timeout that fires after the test environment is gone, which vitest reports
 * as an uncaught `document is not defined` and fails the run.
 */
const openEditors: Editor[] = []

afterEach(() => {
  while (openEditors.length > 0) {
    openEditors.pop()?.destroy()
  }
})

function createTestEditor(markdown = "") {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: createEditorExtensions({
      placeholder: "Type a message...",
      mentionSuggestion: {
        items: () => [],
        render: () => ({ onStart: () => {}, onUpdate: () => {}, onExit: () => {}, onKeyDown: () => false }),
      },
    }),
    content: parseMarkdown(
      markdown,
      () => "user",
      () => null
    ),
  })
  openEditors.push(editor)
  return editor
}

/** Paste `markdown` without formatting into an empty editor and read back what landed. */
function pastePlain(markdown: string): { text: string; json: unknown } {
  const editor = createTestEditor()
  expect(insertPlainText(editor, markdown, () => "user")).toBe(true)
  return { text: editor.getText({ blockSeparator: "\n" }), json: editor.getJSON() }
}

describe("isPlainTextPaste", () => {
  /**
   * Canary: `view.input.shiftKey` is ProseMirror-internal. If an upgrade
   * renames it, plain paste silently reverts to pasting markdown literally —
   * this fails instead.
   */
  it("reads ProseMirror's shift-key state", () => {
    const editor = createTestEditor()
    const input = (editor.view as unknown as { input: { shiftKey: boolean; lastKeyCode: number } }).input

    expect(typeof input.shiftKey).toBe("boolean")
    expect(isPlainTextPaste(editor.view)).toBe(false)

    input.shiftKey = true
    expect(isPlainTextPaste(editor.view)).toBe(true)

    // Shift+Insert is a normal paste, not a plain one.
    input.lastKeyCode = 45
    expect(isPlainTextPaste(editor.view)).toBe(false)
  })
})

describe("markdownToPlainText", () => {
  it("renders chips as the text they display", () => {
    const editor = createTestEditor()

    expect(markdownToPlainText(editor, "[@alice](user:usr_01ABC) shipped it", () => "user")).toBe("@alice shipped it")
  })
})

describe("insertPlainText", () => {
  it("drops inline marks", () => {
    expect(pastePlain("**bold words** and *italic* and `code`").text).toBe("bold words and italic and code")
  })

  it("drops a code fence and keeps its lines", () => {
    const pasted = pastePlain("```ts\nconst a = 1\nconst b = 2\n```")

    expect(pasted.text).toBe("const a = 1\nconst b = 2")
    expect(pasted.json).toEqual({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "const a = 1" }] },
        { type: "paragraph", content: [{ type: "text", text: "const b = 2" }] },
      ],
    })
  })

  it("drops quote markers and heading hashes, one line per block", () => {
    expect(pastePlain("## Heading\n\n> quoted line").text).toBe("Heading\nquoted line")
  })

  it("keeps a bullet list one line per item", () => {
    expect(pastePlain("- one\n- two").text).toBe("one\ntwo")
  })

  it("inserts a link's text, not the link", () => {
    const pasted = pastePlain("see [the docs](https://example.com)")

    expect(pasted.json).toEqual({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "see the docs" }] }],
    })
  })

  it("inserts at the caret inside a code block instead of splitting it into paragraphs", () => {
    const editor = createTestEditor("```ts\nconst a = 1\n```")
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)

    expect(insertPlainText(editor, "```js\nconst b = 2\nconst c = 3\n```")).toBe(true)
    expect(editor.getJSON()).toEqual({
      type: "doc",
      content: [
        {
          type: "codeBlock",
          attrs: { language: "ts" },
          content: [{ type: "text", text: "const a = 1const b = 2\nconst c = 3" }],
        },
      ],
    })
  })

  it("merges the first line into the paragraph at the cursor", () => {
    const editor = createTestEditor("lead ")
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)

    expect(insertPlainText(editor, "**one**\n**two**")).toBe(true)
    expect(editor.getJSON()).toEqual({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "lead one" }] },
        { type: "paragraph", content: [{ type: "text", text: "two" }] },
      ],
    })
  })
})
