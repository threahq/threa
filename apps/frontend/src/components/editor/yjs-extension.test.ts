import { DOC_FRAGMENT } from "@threahq/types"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Editor, type JSONContent } from "@tiptap/core"
import * as Y from "yjs"
import { prosemirrorJSONToYDoc } from "y-prosemirror"
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate } from "y-protocols/awareness"
import { getThreaSchema } from "@threahq/prosemirror/schema"
import { createDocumentExtensions } from "./editor-extensions"

const editors: Editor[] = []

/** y-prosemirror's defaultCursorBuilder pads the caret's name label with word joiners. */
const CARET_WORD_JOINERS = /\u2060/g

function createEditor(ydoc: Y.Doc, awareness: Awareness | null = null): Editor {
  const element = document.createElement("div")
  document.body.append(element)
  const editor = new Editor({ element, extensions: createDocumentExtensions({ ydoc, awareness }) })
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

const awarenesses: Awareness[] = []

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
  for (const awareness of awarenesses.splice(0)) awareness.destroy()
})

describe("YjsCollaboration", () => {
  it("renders the content already in the doc's fragment", () => {
    const ydoc = prosemirrorJSONToYDoc(getThreaSchema(), paragraphs("Rotation tracker", "Week 1"), DOC_FRAGMENT)

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

    expect(ydoc.getXmlFragment(DOC_FRAGMENT).toString()).toContain("hello")
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

  it("routes the platform's historyUndo and historyRedo input to the shared undo", () => {
    const editor = createEditor(new Y.Doc())
    editor.commands.insertContent("hello")
    const fire = (inputType: string) => {
      const event = new InputEvent("beforeinput", { inputType, bubbles: true, cancelable: true })
      editor.view.dom.dispatchEvent(event)
      return event.defaultPrevented
    }

    const undoPrevented = fire("historyUndo")
    const afterUndo = texts(editor)
    const redoPrevented = fire("historyRedo")

    expect({ undoPrevented, afterUndo, redoPrevented, afterRedo: texts(editor) }).toEqual({
      undoPrevented: true,
      afterUndo: [""],
      redoPrevented: true,
      afterRedo: ["hello"],
    })
  })

  it("detaches every Yjs observer it added once the editor is destroyed", () => {
    const ydoc = new Y.Doc()
    const fragment = ydoc.getXmlFragment(DOC_FRAGMENT)
    const observers = () => ({
      fragment: fragment._dEH.l.length,
      doc: Object.fromEntries([...ydoc._observers].map(([event, handlers]) => [event, handlers.size])),
    })
    const before = observers()

    const editor = createEditor(ydoc)
    editor.commands.insertContent("hello")
    expect(observers()).not.toEqual(before)
    editor.destroy()

    expect(observers()).toEqual(before)
  })

  it.each([true, false])(
    "should draw a peer's caret with their name when their awareness carries a cursor and editable is %s",
    async (editable) => {
      const ydoc = prosemirrorJSONToYDoc(getThreaSchema(), paragraphs("hello"), DOC_FRAGMENT)
      const awareness = new Awareness(ydoc)
      const peerDoc = new Y.Doc()
      Y.applyUpdate(peerDoc, Y.encodeStateAsUpdate(ydoc))
      const peer = new Awareness(peerDoc)
      awarenesses.push(awareness, peer)
      const editor = createEditor(ydoc, awareness)
      editor.setEditable(editable)

      const text = peerDoc.getXmlFragment(DOC_FRAGMENT).get(0) as Y.XmlElement
      const at = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text.get(0) as Y.XmlText, 2))
      peer.setLocalState({ user: { name: "Alice", color: "#d97706" }, cursor: { anchor: at, head: at } })
      applyAwarenessUpdate(awareness, encodeAwarenessUpdate(peer, [peer.clientID]), "remote")

      const caret = await vi.waitFor(() => {
        const found = editor.view.dom.querySelector<HTMLElement>(".ProseMirror-yjs-cursor")
        if (!found) throw new Error("no caret yet")
        return found
      })
      expect({
        name: caret.textContent?.replace(CARET_WORD_JOINERS, ""),
        color: caret.style.borderColor,
      }).toEqual({
        name: "Alice",
        color: "rgb(217, 119, 6)",
      })
    }
  )
})
