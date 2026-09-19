import { afterEach, describe, expect, it } from "vitest"
import { Editor, type JSONContent } from "@tiptap/core"
import { TextSelection } from "@tiptap/pm/state"
import { createEditorExtensions } from "./editor-extensions"

function createEditor(text?: string) {
  return createEditorWith(text ? [{ type: "text", text }] : undefined)
}

function createEditorWith(inline?: JSONContent[]) {
  const element = document.createElement("div")
  document.body.append(element)
  const editor = new Editor({
    element,
    extensions: createEditorExtensions({ placeholder: "Type a message..." }),
    content: inline ? { type: "doc", content: [{ type: "paragraph", content: inline }] } : undefined,
  })
  editor.view.hasFocus = () => true
  editor.on("destroy", () => element.remove())
  return editor
}

/** Put the caret somewhere no span covers, so nothing is revealed by the caret. */
function caretToStart(editor: Editor) {
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1)))
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
    caretToStart(editor)

    const [preview] = previews(editor)
    expect(preview?.className).toContain("math-preview-inline")
    expect(preview?.querySelector(".katex")).not.toBeNull()
    expect(editor.getText()).toBe("Euler: $e^{i\\pi}+1=0$ holds")
  })

  it("draws display math as its own block", () => {
    editor = createEditor("$$\\frac{a}{b}$$")
    caretToStart(editor)

    const [preview] = previews(editor)
    expect(preview?.className).toContain("math-preview-block")
    expect(preview?.querySelector(".katex-display")).not.toBeNull()
  })

  it("shows the TeX of the equation the caret sits in, and only that one", () => {
    editor = createEditor("$a^2$ and $b^2$")
    caretToStart(editor)
    expect(previews(editor)).toHaveLength(2)

    // Inside the first span: `$a^2$` occupies positions 1..6.
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 3)))

    expect(previews(editor)).toHaveLength(1)
    expect(editor.view.dom.textContent).toContain("$a^2$")
  })

  it("leaves half-typed TeX alone — no preview, no error box", () => {
    editor = createEditor("half typed $\\frac{")
    caretToStart(editor)

    expect(previews(editor)).toHaveLength(0)
    expect(editor.view.dom.querySelector(".katex-error")).toBeNull()
  })

  it("shows the same error box a message shows for TeX that does not compile", () => {
    editor = createEditor("$\\frac{1}{x$x$")
    caretToStart(editor)

    expect(editor.view.dom.querySelector(".katex-error")).not.toBeNull()
  })

  it("leaves money alone", () => {
    editor = createEditor("it costs $5 and $10")
    caretToStart(editor)

    expect(previews(editor)).toHaveLength(0)
  })

  it("never previews a span carrying a code or link mark", () => {
    editor = createEditor("$a^2$")
    editor.commands.setTextSelection({ from: 1, to: 6 })
    editor.commands.setCode()
    caretToStart(editor)

    expect(previews(editor)).toHaveLength(0)
  })

  it("never previews a span holding a mention — the message would not render it as math", () => {
    editor = createEditorWith([
      { type: "text", text: "$a + " },
      { type: "mention", attrs: { id: "usr_1", slug: "alice", mentionType: "user" } },
      { type: "text", text: "$" },
    ])
    caretToStart(editor)

    // `$a + [@alice](user:usr_1)$` is not math to `extractMath`, so previewing
    // it here would also hide the mention behind an equation nobody will see.
    expect(previews(editor)).toHaveLength(0)
    expect(editor.view.dom.querySelector(".math-source")).toBeNull()
  })

  it("clicking an equation puts the caret at the end of its source, revealing the TeX", () => {
    editor = createEditor("$a^2$ tail")
    caretToStart(editor)

    // Typed ahead of the equation first: the click must land on where the span
    // is now, not where it was drawn.
    editor.view.dispatch(editor.state.tr.insertText("xx ", 1))
    caretToStart(editor)

    const [preview] = previews(editor)
    preview?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))

    // `xx $a^2$ tail`: the source ends at doc position 9.
    expect(editor.state.selection.from).toBe(9)
    expect(previews(editor)).toHaveLength(0)
  })

  it("clicking an equation still lands at its source after the text before it shrank", () => {
    editor = createEditor("$a$ zz $a$")
    caretToStart(editor)
    expect(previews(editor)).toHaveLength(2)

    // Both equations render the same TeX, so both widgets carry the same key:
    // ProseMirror reuses their DOM across the edit below.
    editor.view.dispatch(editor.state.tr.delete(5, 8))
    caretToStart(editor)

    const second = previews(editor)[1]
    second?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))

    // `$a$ $a$`: the second source ends at doc position 8.
    expect(editor.state.selection.from).toBe(8)
  })

  it("ignores math delimiters inside a code block", () => {
    editor = createEditor("$a^2$")
    editor.commands.setTextSelection({ from: 1, to: 6 })
    editor.commands.setCodeBlock()
    caretToStart(editor)

    expect(previews(editor)).toHaveLength(0)
  })
})
