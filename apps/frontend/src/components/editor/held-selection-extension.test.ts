import { afterEach, describe, expect, it } from "vitest"
import { Editor } from "@tiptap/core"
import { TextSelection } from "@tiptap/pm/state"
import { createEditorExtensions } from "./editor-extensions"
import { heldRange } from "./held-selection-extension"

function createEditor(text: string) {
  const element = document.createElement("div")
  document.body.append(element)
  const editor = new Editor({
    element,
    extensions: createEditorExtensions({ placeholder: "Type a message..." }),
    content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] },
  })
  editor.view.hasFocus = () => true
  editor.on("destroy", () => element.remove())
  return editor
}

let editor: Editor

afterEach(() => {
  editor?.destroy()
})

describe("held selection", () => {
  it("should collapse the selection to the range's end and paint the range when held", () => {
    editor = createEditor("hello world")
    editor.commands.setTextSelection({ from: 1, to: 6 })

    expect(editor.commands.holdSelection()).toBe(true)

    expect(editor.state.selection.toJSON()).toEqual({ type: "text", anchor: 6, head: 6 })
    expect(heldRange(editor.state)).toEqual({ from: 1, to: 6 })
    expect(editor.view.dom.querySelector(".held-selection")?.textContent).toBe("hello")
  })

  it("should refuse to hold an empty selection", () => {
    editor = createEditor("hello world")
    editor.commands.setTextSelection(3)

    expect(editor.commands.holdSelection()).toBe(false)
    expect(heldRange(editor.state)).toBeNull()
  })

  it("should apply a mark to the held range and leave the selection collapsed", () => {
    editor = createEditor("hello world")
    editor.commands.setTextSelection({ from: 1, to: 6 })
    editor.commands.holdSelection()

    editor.chain().selectHeld().toggleBold().collapseToHeld().run()

    expect(editor.getHTML()).toBe("<p><strong>hello</strong> world</p>")
    expect(editor.state.selection.toJSON()).toEqual({ type: "text", anchor: 6, head: 6 })
    expect(heldRange(editor.state)).toEqual({ from: 1, to: 6 })
  })

  it("should follow edits and clear itself once the range collapses", () => {
    editor = createEditor("hello world")
    editor.commands.setTextSelection({ from: 7, to: 12 })
    editor.commands.holdSelection()

    editor.commands.insertContentAt(1, "oh ")
    expect(heldRange(editor.state)).toEqual({ from: 10, to: 15 })

    editor.commands.deleteRange({ from: 10, to: 15 })
    expect(heldRange(editor.state)).toBeNull()
    expect(editor.view.dom.querySelector(".held-selection")).toBeNull()
  })

  it("should drop the range on release without moving the caret", () => {
    editor = createEditor("hello world")
    editor.commands.setTextSelection({ from: 1, to: 6 })
    editor.commands.holdSelection()

    editor.commands.releaseHeld()

    expect(heldRange(editor.state)).toBeNull()
    expect(editor.state.selection.toJSON()).toEqual({ type: "text", anchor: 6, head: 6 })
    expect(editor.view.dom.querySelector(".held-selection")).toBeNull()
  })

  it("should drop the range when the user selects new text or taps a caret, but not for its own commands", () => {
    editor = createEditor("hello world")
    editor.commands.setTextSelection({ from: 1, to: 6 })
    editor.commands.holdSelection()

    editor.chain().selectHeld().collapseToHeld().run()
    expect(heldRange(editor.state)).toEqual({ from: 1, to: 6 })

    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 3)).setMeta("pointer", true)
    )
    expect(heldRange(editor.state)).toBeNull()

    editor.commands.setTextSelection({ from: 1, to: 6 })
    editor.commands.holdSelection()
    editor.commands.setTextSelection({ from: 7, to: 12 })
    expect(heldRange(editor.state)).toBeNull()
    expect(editor.view.dom.querySelector(".held-selection")).toBeNull()
  })

  it("should hand the range back as the selection when released through selectHeld", () => {
    editor = createEditor("hello world")
    editor.commands.setTextSelection({ from: 1, to: 6 })
    editor.commands.holdSelection()

    editor.chain().selectHeld().releaseHeld().run()

    expect(heldRange(editor.state)).toBeNull()
    expect(editor.state.selection.toJSON()).toEqual({ type: "text", anchor: 1, head: 6 })
  })

  it("should treat selectHeld and collapseToHeld as no-ops when nothing is held", () => {
    editor = createEditor("hello world")
    editor.commands.setTextSelection({ from: 1, to: 6 })

    editor.chain().selectHeld().toggleBold().collapseToHeld().run()

    expect(editor.getHTML()).toBe("<p><strong>hello</strong> world</p>")
    expect(editor.state.selection.toJSON()).toEqual({ type: "text", anchor: 1, head: 6 })
  })
})
