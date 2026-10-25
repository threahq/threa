import { afterEach, describe, expect, it } from "vitest"
import { Editor, type JSONContent } from "@tiptap/core"
import * as Y from "yjs"
import { prosemirrorJSONToYDoc } from "y-prosemirror"
import { getThreaSchema } from "@threahq/prosemirror/schema"
import { createDocumentExtensions } from "./editor-extensions"

const editors: Editor[] = []

function createEditor(ydoc: Y.Doc): Editor {
  const element = document.createElement("div")
  document.body.append(element)
  const editor = new Editor({ element, extensions: createDocumentExtensions({ ydoc }) })
  editor.on("destroy", () => element.remove())
  editors.push(editor)
  return editor
}

function paragraphs(...texts: string[]): JSONContent {
  return { type: "doc", content: texts.map((text) => ({ type: "paragraph", content: [{ type: "text", text }] })) }
}

function texts(editor: Editor): string[] {
  return editor.state.doc.children.map((block) => block.textContent)
}

/** Forwards every update either doc makes to the other, like a server relaying both ways. */
function connect(a: Y.Doc, b: Y.Doc) {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a), "remote")
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b), "remote")
  a.on("update", (update, origin) => origin !== "remote" && Y.applyUpdate(b, update, "remote"))
  b.on("update", (update, origin) => origin !== "remote" && Y.applyUpdate(a, update, "remote"))
}

function pressUndo(editor: Editor) {
  editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }))
}

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
})

describe("YjsCollaboration", () => {
  it("renders the content already in the doc's fragment", () => {
    const ydoc = prosemirrorJSONToYDoc(getThreaSchema(), paragraphs("Rotation tracker", "Week 1"), "default")

    const editor = createEditor(ydoc)

    expect(editor.getJSON()).toEqual({
      type: "doc",
      content: [
        { type: "paragraph", attrs: { blockId: null }, content: [{ type: "text", text: "Rotation tracker" }] },
        { type: "paragraph", attrs: { blockId: null }, content: [{ type: "text", text: "Week 1" }] },
      ],
    })
  })

  it("writes local edits to the fragment and shows them in a second editor fed the update", () => {
    const ydoc = new Y.Doc()
    const editor = createEditor(ydoc)
    const updates: Uint8Array[] = []
    ydoc.on("update", (update: Uint8Array) => updates.push(update))

    editor.commands.insertContent("hello")

    expect(ydoc.getXmlFragment("default").toString()).toContain("hello")
    const peerDoc = new Y.Doc()
    for (const update of updates) Y.applyUpdate(peerDoc, update)
    const peer = createEditor(peerDoc)
    expect(peer.getJSON()).toEqual(editor.getJSON())
  })

  it("undoes only the local edit, leaving a collaborator's insert in place", () => {
    const ydoc = new Y.Doc()
    const editor = createEditor(ydoc)
    const peerDoc = new Y.Doc()
    const peer = createEditor(peerDoc)
    connect(ydoc, peerDoc)

    peer.commands.insertContent("theirs")
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)
    editor.commands.insertContent(" mine")
    expect(texts(editor)).toEqual(["theirs mine"])

    pressUndo(editor)

    expect({ local: texts(editor), peer: texts(peer) }).toEqual({ local: ["theirs"], peer: ["theirs"] })
  })
})
