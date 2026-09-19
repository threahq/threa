import { afterEach, describe, expect, it } from "vitest"
import { Editor } from "@tiptap/core"
import { TextSelection } from "@tiptap/pm/state"
import { scanMathSpans } from "@threahq/prosemirror"
import { createEditorExtensions } from "./editor-extensions"
import { insertMath } from "./insert-math"

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

function select(editor: Editor, from: number, to: number) {
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)))
}

let editor: Editor

afterEach(() => {
  editor?.destroy()
})

describe("insertMath", () => {
  it("inserts an empty pair with the caret between the delimiters", () => {
    editor = createEditor()
    insertMath(editor)

    expect(editor.getText()).toBe("$$")
    expect(editor.state.selection.from).toBe(2)
  })

  it("wraps the selection and leaves the caret past the equation", () => {
    editor = createEditor("area x^2 done")
    select(editor, 6, 9)
    insertMath(editor)

    expect(editor.getText()).toBe("area $x^2$ done")
    expect(editor.state.selection.from).toBe(11)
    expect(scanMathSpans(editor.getText())).toEqual([{ from: 5, to: 10, tex: "x^2", display: false }])
  })

  it("separates the opener from a word so the pair is math, not dollars", () => {
    editor = createEditor("cost")
    select(editor, 5, 5)
    insertMath(editor)

    expect(editor.getText()).toBe("cost $$")
    expect(editor.state.selection.from).toBe(7)
  })

  it("keeps a wrapped `<` as text instead of parsing it as HTML", () => {
    editor = createEditor("a < b")
    select(editor, 1, 6)
    insertMath(editor)

    expect(editor.getText()).toBe("$a < b$")
  })
})
