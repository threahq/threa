import { afterEach, describe, expect, it } from "vitest"
import { Editor, type JSONContent } from "@tiptap/core"
import { createEditorExtensions } from "./editor-extensions"
import { EditorBehaviors } from "./editor-behaviors"
import { serializeToMarkdown } from "./editor-markdown"

const editors: Editor[] = []

afterEach(() => {
  while (editors.length > 0) editors.pop()?.destroy()
})

function createTestEditor(content: JSONContent = { type: "doc", content: [{ type: "paragraph" }] }) {
  const element = document.createElement("div")
  document.body.append(element)
  const editor = new Editor({
    element,
    extensions: [
      ...createEditorExtensions({ placeholder: "Type a message..." }),
      EditorBehaviors.configure({ sendModeRef: { current: "cmdEnter" } }),
    ],
    content,
  })
  editor.view.hasFocus = () => true
  editor.on("destroy", () => element.remove())
  editors.push(editor)
  editor.commands.focus("end")
  return { editor }
}

function typeText(editor: Editor, text: string) {
  for (const char of text) {
    const { from, to } = editor.state.selection
    const handled = editor.view.someProp("handleTextInput", (handle) =>
      handle(editor.view, from, to, char, () => editor.state.tr.insertText(char, from, to))
    )
    if (!handled) editor.view.dispatch(editor.state.tr.insertText(char, from, to))
  }
}

function pressKey(editor: Editor, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })
  return editor.view.someProp("handleKeyDown", (handle) => handle(editor.view, event)) ?? false
}

const paragraph = (text?: string, blockId: string | null = null): JSONContent => ({
  type: "paragraph",
  attrs: { blockId },
  ...(text ? { content: [{ type: "text", text }] } : {}),
})
const taskItem = (checked: boolean, ...content: JSONContent[]): JSONContent => ({
  type: "taskItem",
  attrs: { checked },
  content,
})
const taskList = (...items: JSONContent[]): JSONContent => ({
  type: "taskList",
  attrs: { blockId: null },
  content: items,
})
const doc = (...content: JSONContent[]): JSONContent => ({ type: "doc", content })

describe("composer task lists", () => {
  it("turns [ ] and [x] typed in a paragraph into task items", () => {
    const { editor: unchecked } = createTestEditor()
    typeText(unchecked, "[ ] buy milk")
    const { editor: checked } = createTestEditor()
    typeText(checked, "[x] done")

    expect([unchecked.getJSON(), checked.getJSON()]).toEqual([
      doc(taskList(taskItem(false, paragraph("buy milk")))),
      doc(taskList(taskItem(true, paragraph("done")))),
    ])
  })

  it("converts the bullet item that `- ` made into a task item", () => {
    const { editor: unchecked } = createTestEditor()
    typeText(unchecked, "- [ ] milk")
    const { editor: checked } = createTestEditor()
    typeText(checked, "- [x] eggs")

    expect([unchecked.getJSON(), checked.getJSON()]).toEqual([
      doc(taskList(taskItem(false, paragraph("milk")))),
      doc(taskList(taskItem(true, paragraph("eggs")))),
    ])
  })

  it("converts `- [] ` into an unchecked task item", () => {
    const { editor } = createTestEditor()
    typeText(editor, "- [] milk")

    expect(editor.getJSON()).toEqual(doc(taskList(taskItem(false, paragraph("milk")))))
  })

  it("keeps an ordered list item ordered when `[ ] ` is typed in it", () => {
    const { editor } = createTestEditor()
    typeText(editor, "1. [ ] milk")

    expect(editor.getJSON()).toEqual(
      doc({
        type: "orderedList",
        attrs: { blockId: null, start: 1, type: null },
        content: [{ type: "listItem", content: [paragraph("[ ] milk")] }],
      })
    )
  })

  it("converts only the bullet item being typed, keeping its siblings bullets", () => {
    const { editor } = createTestEditor()
    typeText(editor, "- a")
    pressKey(editor, "Enter")
    typeText(editor, "[ ] b")

    expect(editor.getJSON()).toEqual(
      doc(
        {
          type: "bulletList",
          attrs: { blockId: null },
          content: [{ type: "listItem", content: [paragraph("a")] }],
        },
        taskList(taskItem(false, paragraph("b")))
      )
    )
  })

  it("splits on Enter, and lifts out of an empty trailing item", () => {
    const { editor } = createTestEditor()
    typeText(editor, "[x] one")
    pressKey(editor, "Enter")
    const afterSplit = editor.getJSON()
    pressKey(editor, "Enter")

    expect({ afterSplit, afterLift: editor.getJSON() }).toEqual({
      afterSplit: doc(taskList(taskItem(true, paragraph("one")), taskItem(false, paragraph()))),
      afterLift: doc(taskList(taskItem(true, paragraph("one"))), paragraph()),
    })
  })

  it("nests with Tab and lifts with Shift-Tab", () => {
    const { editor } = createTestEditor()
    typeText(editor, "[ ] one")
    pressKey(editor, "Enter")
    typeText(editor, "two")
    pressKey(editor, "Tab")
    const nested = editor.getJSON()
    pressKey(editor, "Tab", { shiftKey: true })

    expect({ nested, lifted: editor.getJSON() }).toEqual({
      nested: doc(taskList(taskItem(false, paragraph("one"), taskList(taskItem(false, paragraph("two")))))),
      lifted: doc(taskList(taskItem(false, paragraph("one")), taskItem(false, paragraph("two")))),
    })
  })

  it("toggles checked from the checkbox", () => {
    const { editor } = createTestEditor()
    typeText(editor, "[ ] buy milk")
    const checkbox = editor.view.dom.querySelector<HTMLInputElement>('ul[data-type="taskList"] > li input')!
    checkbox.checked = true
    checkbox.dispatchEvent(new Event("change", { bubbles: true }))

    expect(editor.getJSON()).toEqual(doc(taskList(taskItem(true, paragraph("buy milk")))))
  })

  it("serializes to GFM task list markdown", () => {
    const { editor } = createTestEditor()
    typeText(editor, "[ ] buy milk")
    pressKey(editor, "Enter")
    typeText(editor, "done")
    editor.commands.updateAttributes("taskItem", { checked: true })

    expect(serializeToMarkdown(editor.getJSON())).toBe("- [ ] buy milk\n- [x] done")
  })

  it("keeps loaded block ids and leaves new blocks without one", () => {
    const loaded = doc(paragraph("intro", "blk_intro"), {
      type: "taskList",
      attrs: { blockId: "blk_list" },
      content: [{ type: "taskItem", attrs: { checked: false }, content: [paragraph("milk", "blk_milk")] }],
    })
    const { editor } = createTestEditor(loaded)
    const roundTrip = editor.getJSON()
    pressKey(editor, "Enter")
    pressKey(editor, "Enter")

    expect({ roundTrip, afterEnter: editor.getJSON() }).toEqual({
      roundTrip: loaded,
      afterEnter: { ...loaded, content: [...loaded.content!, paragraph()] },
    })
  })
})
