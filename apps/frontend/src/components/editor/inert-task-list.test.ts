import { afterEach, describe, expect, it } from "vitest"
import { Editor } from "@tiptap/core"
import { createEditorExtensions } from "./editor-extensions"
import { EditorBehaviors } from "./editor-behaviors"

const editors: Editor[] = []

afterEach(() => {
  while (editors.length > 0) editors.pop()?.destroy()
})

function createTestEditor() {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [...createEditorExtensions({ placeholder: "Type a message..." }), EditorBehaviors],
    content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "todo" }] }] },
  })
  editors.push(editor)
  return editor
}

function nodeTypes(editor: Editor): string[] {
  const types: string[] = []
  editor.state.doc.descendants((node) => {
    types.push(node.type.name)
  })
  return types
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

describe("composer task lists are inert schema members", () => {
  it("keeps the schema nodes while every authoring path stays closed", () => {
    const editor = createTestEditor()
    const schemaNodes = ["taskList", "taskItem"].filter((name) => editor.schema.nodes[name] !== undefined)

    editor.commands.setTextSelection(2)
    const shortcut = new KeyboardEvent("keydown", {
      key: "(",
      code: "Digit9",
      keyCode: 57,
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    })
    editor.view.someProp("handleKeyDown", (handle) => handle(editor.view, shortcut))
    const afterShortcut = nodeTypes(editor)

    const toggle = (editor.commands as Record<string, unknown>).toggleTaskList

    editor.commands.setContent({ type: "doc", content: [{ type: "paragraph" }] })
    editor.commands.setTextSelection(1)
    typeText(editor, "- [ ] ")
    const afterTyping = nodeTypes(editor)

    editor.commands.setContent({ type: "doc", content: [{ type: "paragraph" }] })
    editor.commands.setTextSelection(1)
    typeText(editor, "[ ] ")
    const afterBareTyping = nodeTypes(editor)

    editor.commands.setContent({ type: "doc", content: [{ type: "paragraph" }] })
    editor.view.pasteHTML(
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>pasted</p></li></ul>',
      // jsdom has no ClipboardEvent; pasteHTML only forwards it to paste handlers.
      new Event("paste") as ClipboardEvent
    )
    const afterPaste = nodeTypes(editor)

    expect({
      schemaNodes,
      shortcutMadeTaskList: afterShortcut.includes("taskList"),
      toggleCommand: toggle,
      typedBullet: afterTyping.includes("bulletList"),
      typedTaskItem: afterTyping.includes("taskItem") || afterBareTyping.includes("taskItem"),
      pastedTaskItem: afterPaste.includes("taskItem"),
      pastedText: editor.state.doc.textContent,
    }).toEqual({
      schemaNodes: ["taskList", "taskItem"],
      shortcutMadeTaskList: false,
      toggleCommand: undefined,
      typedBullet: true,
      typedTaskItem: false,
      pastedTaskItem: false,
      pastedText: "pasted",
    })
  })
})
