import { afterEach, describe, expect, it } from "vitest"
import { Editor } from "@tiptap/core"
import { TextSelection } from "@tiptap/pm/state"
import { createEditorExtensions } from "./editor-extensions"

function createEditor(text?: string) {
  const element = document.createElement("div")
  document.body.append(element)
  const editor = new Editor({
    element,
    extensions: createEditorExtensions({ placeholder: "Type a message..." }),
    content: text ? { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] } : undefined,
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

  it("ignores math delimiters inside a code block", () => {
    editor = createEditor("$a^2$")
    editor.commands.setTextSelection({ from: 1, to: 6 })
    editor.commands.setCodeBlock()
    caretToStart(editor)

    expect(previews(editor)).toHaveLength(0)
  })
})
