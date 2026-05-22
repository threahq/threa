import { afterEach, describe, expect, it } from "vitest"
import { Editor } from "@tiptap/core"
import type { JSONContent } from "@tiptap/react"
import { createEditorExtensions } from "./editor-extensions"

function createEditor(content?: JSONContent) {
  const element = document.createElement("div")
  document.body.append(element)
  const editor = new Editor({
    element,
    extensions: createEditorExtensions({ placeholder: "Type a message..." }),
    content: content ?? { type: "doc", content: [{ type: "paragraph" }] },
  })
  editor.view.hasFocus = () => true
  editor.on("destroy", () => element.remove())
  return editor
}

let editor: Editor

afterEach(() => {
  editor?.destroy()
})

describe("dictation preview", () => {
  it("renders the live hypothesis as a ghost and clears it", () => {
    editor = createEditor()

    expect(editor.view.dom.querySelector(".dictation-preview-ghost")).toBeNull()

    editor.commands.setDictationPreview("hello there")
    const ghost = editor.view.dom.querySelector(".dictation-preview-ghost")
    expect(ghost?.textContent).toBe("hello there")

    editor.commands.setDictationPreview("")
    expect(editor.view.dom.querySelector(".dictation-preview-ghost")).toBeNull()
  })

  it("never writes the preview into the document", () => {
    editor = createEditor()
    editor.commands.setDictationPreview("not committed")

    expect(editor.getText()).toBe("")
  })
})
