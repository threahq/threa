import { afterEach, describe, expect, it } from "vitest"
import { Editor, type JSONContent } from "@tiptap/core"
import { TextSelection } from "@tiptap/pm/state"
import { createEditorExtensions } from "./editor-extensions"

function createEditor(text?: string) {
  return createEditorWith(text ? [{ type: "text", text }] : undefined)
}

function createEditorWith(inline?: JSONContent[]) {
  return createEditorFrom(inline ? { type: "doc", content: [{ type: "paragraph", content: inline }] } : undefined)
}

function createEditorFrom(content?: JSONContent) {
  const element = document.createElement("div")
  document.body.append(element)
  const editor = new Editor({
    element,
    extensions: createEditorExtensions({ placeholder: "Type a message..." }),
    content,
  })
  editor.view.hasFocus = () => true
  editor.on("destroy", () => element.remove())
  return editor
}

/** Where the caret is after typing a message: past everything written. */
function caretToEnd(editor: Editor) {
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.atEnd(editor.state.doc)))
}

function caretTo(editor: Editor, pos: number) {
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos)))
}

/** A paragraph per line, which is what Enter in the composer produces. */
function paragraphs(...lines: string[]): JSONContent {
  return {
    type: "doc",
    content: lines.map((line) => ({ type: "paragraph", content: line ? [{ type: "text", text: line }] : undefined })),
  }
}

function previews(editor: Editor) {
  return Array.from(editor.view.dom.querySelectorAll(".math-preview"))
}

let editor: Editor

afterEach(() => {
  editor?.destroy()
})

describe("math preview", () => {
  it("draws a finished inline equation and leaves the document as typed", () => {
    editor = createEditor("Euler: $e^{i\\pi}+1=0$ holds")
    caretToEnd(editor)

    const [preview] = previews(editor)
    expect(preview?.className).toContain("math-preview-inline")
    expect(preview?.querySelector(".katex")).not.toBeNull()
    expect(editor.getText()).toBe("Euler: $e^{i\\pi}+1=0$ holds")
  })

  it("draws display math as its own block", () => {
    editor = createEditor("$$\\frac{a}{b}$$")
    caretToEnd(editor)

    const [preview] = previews(editor)
    expect(preview?.className).toContain("math-preview-block")
    expect(preview?.querySelector(".katex-display")).not.toBeNull()
  })

  it("shows the TeX of the equation the caret sits in, and only that one", () => {
    editor = createEditor("$a^2$ and $b^2$")
    caretToEnd(editor)
    expect(previews(editor)).toHaveLength(2)

    // Inside the first span: `$a^2$` occupies positions 1..6.
    caretTo(editor, 3)

    expect(previews(editor)).toHaveLength(1)
    expect(editor.view.dom.textContent).toContain("$a^2$")
  })

  it("leaves half-typed TeX alone — no preview, no error box", () => {
    editor = createEditor("half typed $\\frac{")
    caretToEnd(editor)

    expect(previews(editor)).toHaveLength(0)
    expect(editor.view.dom.querySelector(".katex-error")).toBeNull()
  })

  it("shows the same error box a message shows for TeX that does not compile", () => {
    editor = createEditor("$\\frac{1}{x$x$")
    caretToEnd(editor)

    expect(editor.view.dom.querySelector(".katex-error")).not.toBeNull()
  })

  it("leaves money alone", () => {
    editor = createEditor("it costs $5 and $10")
    caretToEnd(editor)

    expect(previews(editor)).toHaveLength(0)
  })

  it("never previews a span carrying a code or link mark", () => {
    editor = createEditor("$a^2$")
    editor.commands.setTextSelection({ from: 1, to: 6 })
    editor.commands.setCode()
    caretToEnd(editor)

    expect(previews(editor)).toHaveLength(0)
  })

  it("never previews a span holding a mention — the message would not render it as math", () => {
    editor = createEditorWith([
      { type: "text", text: "$a + " },
      { type: "mention", attrs: { id: "usr_1", slug: "alice", mentionType: "user" } },
      { type: "text", text: "$" },
    ])
    caretToEnd(editor)

    // `$a + [@alice](user:usr_1)$` is not math to `extractMath`, so previewing
    // it here would also hide the mention behind an equation nobody will see.
    expect(previews(editor)).toHaveLength(0)
    expect(editor.view.dom.querySelector(".math-source")).toBeNull()
  })

  it("clicking an equation puts the caret at the end of its source, revealing the TeX", () => {
    editor = createEditor("$a^2$ tail")
    caretToEnd(editor)

    // Typed ahead of the equation first: the click must land on where the span
    // is now, not where it was drawn.
    editor.view.dispatch(editor.state.tr.insertText("xx ", 1))
    caretToEnd(editor)

    const [preview] = previews(editor)
    preview?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))

    // `xx $a^2$ tail`: the source ends at doc position 9, and the caret has to
    // land short of it — position 9 is where the equation draws again.
    expect(editor.state.selection.from).toBe(8)
    expect(previews(editor)).toHaveLength(0)
  })

  it("clicking an equation still lands at its source after the text before it shrank", () => {
    editor = createEditor("$a$ zz $a$")
    caretToEnd(editor)
    expect(previews(editor)).toHaveLength(2)

    // Both equations render the same TeX, so both widgets carry the same key:
    // ProseMirror reuses their DOM across the edit below.
    editor.view.dispatch(editor.state.tr.delete(5, 8))
    caretToEnd(editor)

    const second = previews(editor)[1]
    second?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))

    // `$a$ $a$`: the second source ends at doc position 8.
    expect(editor.state.selection.from).toBe(7)
  })

  it("draws the equation the moment the closing delimiter is typed", () => {
    editor = createEditor("$x^2$")
    // Where the caret is one keystroke after `$x^2$` is finished. This is the
    // whole gesture — an equation that only draws once you click away is not a
    // preview of anything.
    caretTo(editor, 6)

    expect(previews(editor)).toHaveLength(1)
  })

  it("draws display math written across paragraphs, the way Enter writes it", () => {
    editor = createEditorFrom(paragraphs("$$", "\\frac{9}{31}", "$$"))
    caretToEnd(editor)

    const [preview] = previews(editor)
    expect(preview?.className).toContain("math-preview-block")
    expect(preview?.querySelector(".katex-display")).not.toBeNull()
    // All three lines of source collapse behind the one equation they describe.
    expect(editor.view.dom.querySelectorAll(".math-source-block")).toHaveLength(3)
    expect(editor.getText()).toContain("\\frac{9}{31}")
  })

  it("gives the source lines back when the caret is inside multi-paragraph math", () => {
    editor = createEditorFrom(paragraphs("$$", "\\frac{9}{31}", "$$"))
    // Inside the body paragraph, which starts at doc position 5.
    caretTo(editor, 8)

    expect(previews(editor)).toHaveLength(0)
    expect(editor.view.dom.querySelectorAll(".math-source-block")).toHaveLength(0)
    expect(editor.view.dom.textContent).toContain("$$")
  })

  it("does not read a price in one paragraph and a price in the next as one equation", () => {
    editor = createEditorFrom(paragraphs("costs $5", "and 10$"))
    caretToEnd(editor)

    expect(previews(editor)).toHaveLength(0)
  })

  it("does not join paragraphs inside a quote, where each line carries a marker", () => {
    editor = createEditorFrom({
      type: "doc",
      content: [{ type: "blockquote", content: paragraphs("$$", "\\frac{a}{b}", "$$").content }],
    })
    caretToEnd(editor)

    // `> $$` / `> \frac{a}{b}` / `> $$` is not math once it is serialized, so
    // drawing an equation for it would promise something the message breaks.
    expect(previews(editor)).toHaveLength(0)
  })

  it("ignores math delimiters inside a code block", () => {
    editor = createEditor("$a^2$")
    editor.commands.setTextSelection({ from: 1, to: 6 })
    editor.commands.setCodeBlock()
    caretToEnd(editor)

    expect(previews(editor)).toHaveLength(0)
  })
})
