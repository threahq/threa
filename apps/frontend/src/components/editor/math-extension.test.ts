import { afterEach, describe, expect, it } from "vitest"
import { Editor, type JSONContent } from "@tiptap/core"
import { TextSelection } from "@tiptap/pm/state"
import { createEditorExtensions } from "./editor-extensions"
import { mathEditingState, openSelectedMath } from "./math-extension"
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

/**
 * A real keydown through the view: `keyboardShortcut` replays only the steps of
 * the transaction it captures, so a handler that changes plugin state or the
 * selection looks like it did nothing.
 */
function press(editor: Editor, key: string): boolean {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
  return editor.view.someProp("handleKeyDown", (handler) => handler(editor.view, event)) ?? false
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
    expect(mathEditingState(editor.state)).toEqual({ pos: 6, caret: "end" })
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
    const pos = mathEditingState(editor.state)!.pos

    editor.commands.commitMath(pos, { tex: "x^2", display: false })

    expect(inline(editor)).toEqual([
      { type: "text", text: "so " },
      { type: "math", attrs: { tex: "x^2", display: false } },
    ])
    expect(mathEditingState(editor.state)).toBeNull()
    expect(editor.state.selection.$from.nodeBefore?.type.name).toBe("math")
  })

  it("deletes the node when the TeX is left empty, so nothing invisible stays behind", () => {
    editor = createEditorWith([{ type: "text", text: "so " }])
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)
    editor.commands.insertMath()
    const pos = mathEditingState(editor.state)!.pos

    editor.commands.commitMath(pos, { tex: "   ", display: false })

    expect(inline(editor)).toEqual([{ type: "text", text: "so " }])
    expect(mathEditingState(editor.state)).toBeNull()
  })

  it("opens a display equation from `$$` and Enter, the way ``` opens a code block", () => {
    editor = createEditorWith([{ type: "text", text: "$$" }])
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)

    expect(handleEnterTextBehavior(editor)).toBe(true)
    expect(inline(editor)).toEqual([{ type: "math", attrs: { tex: "", display: true } }])
    expect(mathEditingState(editor.state)).not.toBeNull()
  })

  it("keeps an equation when a code fence is typed after it", () => {
    editor = createEditorWith([
      { type: "math", attrs: { tex: "x^2", display: true } },
      { type: "text", text: "```" },
    ])
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)

    handleEnterTextBehavior(editor)

    expect(editor.getJSON().content?.some((block) => block.type === "codeBlock")).toBe(false)
    expect(inline(editor)[0]).toEqual({ type: "math", attrs: { tex: "x^2", display: true } })
  })

  it("follows the node when an edit before it moves it", () => {
    editor = createEditorWith([{ type: "text", text: "x" }])
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)
    editor.commands.insertMath()
    const before = mathEditingState(editor.state)!.pos

    editor.view.dispatch(editor.state.tr.insertText("abc", 1, 1))

    expect(mathEditingState(editor.state)?.pos).toBe(before + 3)
  })

  it("opens the TeX from the far end when the caret arrows into the equation", () => {
    editor = createEditorWith([
      { type: "text", text: "a" },
      { type: "math", attrs: { tex: "x^2", display: false } },
      { type: "text", text: "b" },
    ])
    // Right behind the equation: the next ArrowLeft would step over it.
    editor.commands.setTextSelection(3)

    expect(press(editor, "ArrowLeft")).toBe(true)
    expect(mathEditingState(editor.state)).toEqual({ pos: 2, caret: "end" })

    editor.commands.commitMath(2, { tex: "x^2", display: false }, "before")
    expect(press(editor, "ArrowRight")).toBe(true)
    expect(mathEditingState(editor.state)).toEqual({ pos: 2, caret: "start" })
  })

  it("leaves the caret on the side it left the field by", () => {
    editor = createEditorWith([
      { type: "text", text: "a" },
      { type: "math", attrs: { tex: "x^2", display: false } },
      { type: "text", text: "b" },
    ])

    editor.commands.commitMath(2, { tex: "x^2", display: false }, "before")
    expect(editor.state.selection.$from.nodeAfter?.type.name).toBe("math")

    editor.commands.commitMath(2, { tex: "x^2", display: false }, "after")
    expect(editor.state.selection.$from.nodeBefore?.type.name).toBe("math")
  })

  it("opens a selected equation rather than letting Enter send the message", () => {
    editor = createEditorWith([{ type: "math", attrs: { tex: "x^2", display: false } }])
    editor.commands.setNodeSelection(1)

    expect(openSelectedMath(editor)).toBe(true)
    expect(mathEditingState(editor.state)).toEqual({ pos: 1, caret: "end" })
  })
})
