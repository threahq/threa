import { afterEach, describe, expect, it } from "vitest"
import { Editor, type JSONContent } from "@tiptap/core"
import { TextSelection } from "@tiptap/pm/state"
import { createEditorExtensions } from "./editor-extensions"
import { MathEditingKey } from "./math-extension"
import { handleEnterTextBehavior } from "./multiline-blocks"

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

/** Keystrokes, not `insertContent`: input rules only see text input. */
function type(editor: Editor, text: string) {
  for (const char of text) {
    const { from, to } = editor.state.selection
    const insert = () => editor.state.tr.insertText(char, from, to)
    const handled = editor.view.someProp("handleTextInput", (handler) => handler(editor.view, from, to, char, insert))
    if (!handled) editor.view.dispatch(insert())
  }
}

function inline(editor: Editor): JSONContent[] {
  return editor.getJSON().content?.[0]?.content ?? []
}

function selectionIsAfter(editor: Editor, node: JSONContent): boolean {
  const { $from } = editor.state.selection
  return $from.nodeBefore?.type.name === "math" && $from.nodeBefore?.attrs.tex === node.attrs?.tex
}

let editor: Editor

afterEach(() => {
  editor?.destroy()
})

describe("math node", () => {
  it("turns a finished inline equation into a node as the closing delimiter lands", () => {
    editor = createEditorWith()
    type(editor, "Euler: $e^{i\\pi}+1=0$")

    expect(inline(editor)).toEqual([
      { type: "text", text: "Euler: " },
      { type: "math", attrs: { tex: "e^{i\\pi}+1=0", display: false } },
    ])
    // Typing one and inserting one from the toolbar have to agree on where the
    // caret ends up, or the two gestures feel like different features.
    expect(selectionIsAfter(editor, { attrs: { tex: "e^{i\\pi}+1=0" } })).toBe(true)
  })

  it("leaves prices as prose", () => {
    editor = createEditorWith()
    type(editor, "costs $5 and $10")

    expect(inline(editor)).toEqual([{ type: "text", text: "costs $5 and $10" }])
  })

  it("takes `\\[…\\]` as a display equation", () => {
    editor = createEditorWith()
    type(editor, "\\[\\frac{9}{31}\\]")

    expect(inline(editor)).toEqual([{ type: "math", attrs: { tex: "\\frac{9}{31}", display: true } }])
  })

  it("refuses a span holding a mention, because the sent message would not render it either", () => {
    editor = createEditorWith([
      { type: "text", text: "$" },
      { type: "mention", attrs: { id: "usr_1", slug: "alice", mentionType: "user" } },
    ])
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.atEnd(editor.state.doc)))
    type(editor, "$")

    expect(inline(editor).some((node) => node.type === "math")).toBe(false)
    expect(inline(editor).some((node) => node.type === "mention")).toBe(true)
  })

  it("wraps the selection and opens its TeX", () => {
    editor = createEditorWith([{ type: "text", text: "area x^2" }])
    editor.commands.setTextSelection({ from: 6, to: 9 })
    editor.commands.insertMath()

    expect(inline(editor)).toEqual([
      { type: "text", text: "area " },
      { type: "math", attrs: { tex: "x^2", display: false } },
    ])
    expect(MathEditingKey.getState(editor.state)).toBe(6)
  })

  it("keeps a mention out of the TeX rather than flattening it into one", () => {
    editor = createEditorWith([
      { type: "text", text: "ping " },
      { type: "mention", attrs: { id: "usr_1", slug: "alice", mentionType: "user" } },
    ])
    editor.commands.setTextSelection({ from: 1, to: editor.state.doc.content.size - 1 })
    editor.commands.insertMath()

    expect(inline(editor)).toEqual([
      { type: "text", text: "ping " },
      { type: "mention", attrs: { id: "usr_1", slug: "alice", mentionType: "user" } },
      { type: "math", attrs: { tex: "", display: false } },
    ])
  })

  it("commits the TeX and leaves the caret after the equation", () => {
    editor = createEditorWith([{ type: "text", text: "so " }])
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)
    editor.commands.insertMath()
    const pos = MathEditingKey.getState(editor.state) as number

    editor.commands.commitMath(pos, { tex: "x^2", display: false })

    expect(inline(editor)).toEqual([
      { type: "text", text: "so " },
      { type: "math", attrs: { tex: "x^2", display: false } },
    ])
    expect(MathEditingKey.getState(editor.state)).toBeNull()
    expect(editor.state.selection.$from.nodeBefore?.type.name).toBe("math")
  })

  it("deletes the node when the TeX is left empty, so nothing invisible stays behind", () => {
    editor = createEditorWith([{ type: "text", text: "so " }])
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)
    editor.commands.insertMath()
    const pos = MathEditingKey.getState(editor.state) as number

    editor.commands.commitMath(pos, { tex: "   ", display: false })

    expect(inline(editor)).toEqual([{ type: "text", text: "so " }])
    expect(MathEditingKey.getState(editor.state)).toBeNull()
  })

  it("opens a display equation from `$$` and Enter, the way ``` opens a code block", () => {
    editor = createEditorWith([{ type: "text", text: "$$" }])
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)

    expect(handleEnterTextBehavior(editor)).toBe(true)
    expect(inline(editor)).toEqual([{ type: "math", attrs: { tex: "", display: true } }])
    expect(MathEditingKey.getState(editor.state)).not.toBeNull()
  })

  it("follows the node when an edit before it moves it", () => {
    editor = createEditorWith([{ type: "text", text: "x" }])
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)
    editor.commands.insertMath()
    const before = MathEditingKey.getState(editor.state) as number

    editor.view.dispatch(editor.state.tr.insertText("abc", 1, 1))

    expect(MathEditingKey.getState(editor.state)).toBe(before + 3)
  })
})
