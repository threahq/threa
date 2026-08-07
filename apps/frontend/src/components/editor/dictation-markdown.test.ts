import { afterEach, describe, expect, it, vi } from "vitest"
import { Editor } from "@tiptap/core"
import type { JSONContent } from "@tiptap/react"
import { createEditorExtensions } from "./editor-extensions"
import { getDictationMarkdownContext } from "./dictation-markdown"

function make(content: JSONContent) {
  const element = document.createElement("div")
  document.body.append(element)
  const editor = new Editor({ element, extensions: createEditorExtensions({ placeholder: "" }), content })
  editor.on("destroy", () => element.remove())
  return editor
}

let editor: Editor
afterEach(() => editor?.destroy())

describe("dictation Markdown context", () => {
  it("preserves headings, marks, lists, and excludes the selection", () => {
    editor = make({
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Title" }] },
        {
          type: "paragraph",
          content: [
            { type: "text", marks: [{ type: "bold" }], text: "before" },
            { type: "text", text: " selected after" },
          ],
        },
        {
          type: "bulletList",
          content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "item" }] }] }],
        },
      ],
    })
    const selectedFrom = 15
    const context = getDictationMarkdownContext(editor.state.doc, { from: selectedFrom, to: selectedFrom + 9 }, 200)
    expect(context).toEqual({ before: "## Title\n\n**before**", after: "after\n\n- item" })
  })

  it("caps at serializable structure and Unicode boundaries", () => {
    editor = make({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", marks: [{ type: "bold" }], text: "ab😀cdefghij" }] }],
    })
    const middle = 7
    const context = getDictationMarkdownContext(editor.state.doc, { from: middle, to: middle }, 8)
    expect(context.before.length).toBeLessThanOrEqual(8)
    expect(context.after.length).toBeLessThanOrEqual(8)
    expect(context.before).not.toMatch(/[\uD800-\uDBFF]$/)
    expect(context.after).not.toMatch(/^[\uDC00-\uDFFF]/)
    expect(() => context.before.match(/\*\*/g)).not.toThrow()
  })

  it("bounds serialization attempts for a long draft", () => {
    const text = "a".repeat(100_000)
    editor = make({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] })
    const cut = vi.spyOn(editor.state.doc, "cut")
    const middle = Math.floor(editor.state.doc.content.size / 2)

    const context = getDictationMarkdownContext(editor.state.doc, { from: middle, to: middle }, 2_000)

    expect(context).toEqual({ before: "a".repeat(2_000), after: "a".repeat(2_000) })
    expect(cut.mock.calls.length).toBeLessThanOrEqual(40)
  })
})
