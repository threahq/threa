import { afterEach, describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import { Editor } from "@tiptap/react"
import * as Y from "yjs"
import { createDocumentExtensions } from "@/components/editor/editor-extensions"
import { requestBlockFocus } from "@/lib/docs/block-focus"
import { useDocBlockLanding } from "./use-doc-block-landing"

const DOC_ID = "stream_doc"
const editors: Editor[] = []

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
  vi.useRealTimers()
})

function createEditor(): Editor {
  const element = document.createElement("div")
  document.body.append(element)
  const editor = new Editor({ element, extensions: createDocumentExtensions({ ydoc: new Y.Doc(), awareness: null }) })
  editor.on("destroy", () => element.remove())
  editors.push(editor)
  return editor
}

function pressUndo(editor: Editor) {
  editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }))
}

describe("useDocBlockLanding", () => {
  it("should leave undo working for typing after the doc lands on a block", () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] })
    const editor = createEditor()
    editor.commands.insertContent("first")
    editor.commands.updateAttributes("paragraph", { blockId: "blk_first" })
    // Past Yjs's capture window, so the next typing is its own undo step.
    vi.advanceTimersByTime(1000)

    requestBlockFocus(DOC_ID, "blk_first")
    renderHook(() => useDocBlockLanding(editor, DOC_ID))
    editor.commands.insertContent(" second")
    pressUndo(editor)

    expect(editor.state.doc.textContent).toBe("first")
  })
})
