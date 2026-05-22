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

  it("fades only the newly-arrived tail when a partial grows", () => {
    editor = createEditor()

    editor.commands.setDictationPreview("hello")
    editor.commands.setDictationPreview("hello there")

    const ghost = editor.view.dom.querySelector(".dictation-preview-ghost")
    expect(ghost?.textContent).toBe("hello there")
    // Only the appended tail carries the fade class; the carry-over prefix
    // paints instantly so the line grows word-by-word.
    expect(ghost?.querySelector(".dictation-preview-ghost__fresh")?.textContent).toBe(" there")
  })

  it("fades the whole hypothesis when a partial is revised without a shared prefix", () => {
    editor = createEditor()

    editor.commands.setDictationPreview("umm")
    editor.commands.setDictationPreview("the cat")

    const fresh = editor.view.dom.querySelector(".dictation-preview-ghost__fresh")
    expect(fresh?.textContent).toBe("the cat")
  })
})
