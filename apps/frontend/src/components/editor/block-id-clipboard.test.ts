import { afterEach, describe, expect, it } from "vitest"
import { Editor, type JSONContent } from "@tiptap/core"
import { TextSelection } from "@tiptap/pm/state"
import * as Y from "yjs"
import { prosemirrorJSONToYDoc } from "y-prosemirror"
import { DOC_FRAGMENT } from "@threahq/types"
import { getThreaSchema } from "@threahq/prosemirror/schema"
import { createDocumentExtensions } from "./editor-extensions"

const FIRST_ID = `blk_${"0".repeat(25)}1`
const SECOND_ID = `blk_${"0".repeat(25)}2`

const editors: Editor[] = []

function createEditor(): Editor {
  const content: JSONContent = {
    type: "doc",
    content: [
      { type: "paragraph", attrs: { blockId: FIRST_ID }, content: [{ type: "text", text: "First block" }] },
      { type: "paragraph", attrs: { blockId: SECOND_ID }, content: [{ type: "text", text: "Second block" }] },
    ],
  }
  const ydoc: Y.Doc = prosemirrorJSONToYDoc(getThreaSchema(), content, DOC_FRAGMENT)
  const element = document.createElement("div")
  document.body.append(element)
  const editor = new Editor({ element, extensions: createDocumentExtensions({ ydoc, awareness: null }) })
  editor.on("destroy", () => element.remove())
  editors.push(editor)
  return editor
}

function blocks(editor: Editor): Array<{ text: string; blockId: unknown }> {
  return editor.state.doc.children.map((node) => ({ text: node.textContent, blockId: node.attrs.blockId }))
}

/** Copies the selection the way the browser's copy event does, returning the clipboard's HTML. */
function copySelection(editor: Editor): string {
  const { dom } = editor.view.serializeForClipboard(editor.state.selection.content())
  return dom.innerHTML
}

/** Selects from the end of the first block through the end of the second, the second block whole. */
function selectSecondBlock(editor: Editor) {
  const firstEnd = editor.state.doc.child(0).nodeSize - 1
  const docEnd = editor.state.doc.content.size - 1
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, firstEnd, docEnd)))
}

/** The DOM test environment has no `ClipboardEvent`, which `pasteHTML` would build by default. */
function paste(editor: Editor, html: string) {
  editor.view.pasteHTML(html, new Event("paste") as ClipboardEvent)
}

function newBlockAtEnd(editor: Editor) {
  editor.chain().focus("end").splitBlock().run()
}

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
})

describe("BlockIdClipboard", () => {
  it("should keep a block's id when it is cut and pasted in the same editor", () => {
    const editor = createEditor()
    selectSecondBlock(editor)
    const html = copySelection(editor)
    editor.commands.deleteSelection()
    newBlockAtEnd(editor)

    paste(editor, html)

    expect(blocks(editor)).toEqual([
      { text: "First block", blockId: FIRST_ID },
      { text: "", blockId: null },
      { text: "Second block", blockId: SECOND_ID },
    ])
  })

  it("should leave a copied block's id on the original when the copy is pasted", () => {
    const editor = createEditor()
    selectSecondBlock(editor)
    const html = copySelection(editor)
    newBlockAtEnd(editor)

    paste(editor, html)

    expect(blocks(editor).filter((block) => block.blockId === SECOND_ID)).toEqual([
      { text: "Second block", blockId: SECOND_ID },
    ])
    expect(blocks(editor).at(-1)).toEqual({ text: "Second block", blockId: null })
  })

  it("should not restore ids into a paste that differs from what was copied", () => {
    const editor = createEditor()
    selectSecondBlock(editor)
    copySelection(editor)
    editor.commands.deleteSelection()
    newBlockAtEnd(editor)

    paste(editor, "<p></p><p>Something else</p>")

    expect(blocks(editor).map((block) => block.blockId)).not.toContain(SECOND_ID)
  })
})
