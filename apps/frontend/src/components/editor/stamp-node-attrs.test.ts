import { DOC_FRAGMENT } from "@threahq/types"
import { afterEach, describe, expect, it } from "vitest"
import { Editor, type JSONContent } from "@tiptap/core"
import { prosemirrorJSONToYDoc } from "y-prosemirror"
import { getThreaSchema } from "@threahq/prosemirror/schema"
import { createDocumentExtensions, createEditorExtensions } from "./editor-extensions"
import { stampNodeAttrs } from "./stamp-node-attrs"

const LINK_DOC: JSONContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "inAppLink", attrs: { url: "/w/ws_1/s/stream_1", streamId: "stream_1", name: "" } }],
    },
  ],
}

const editors: Editor[] = []

function mount(editor: Editor): Editor {
  editors.push(editor)
  return editor
}

function stampLinkName(editor: Editor): void {
  let linkPos = -1
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "inAppLink") linkPos = pos
  })
  stampNodeAttrs({ editor, getPos: () => linkPos }, "inAppLink", { name: "general" })
}

function linkName(editor: Editor): unknown {
  return editor.state.doc.firstChild?.firstChild?.attrs.name
}

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
})

describe("stampNodeAttrs", () => {
  it("leaves a shared document untouched", () => {
    const ydoc = prosemirrorJSONToYDoc(getThreaSchema(), LINK_DOC, DOC_FRAGMENT)
    const editor = mount(new Editor({ extensions: createDocumentExtensions({ ydoc }) }))
    const fragmentBefore = ydoc.getXmlFragment(DOC_FRAGMENT).toString()
    const docBefore = editor.state.doc

    stampLinkName(editor)

    expect({
      fragment: ydoc.getXmlFragment(DOC_FRAGMENT).toString(),
      docUnchanged: editor.state.doc === docBefore,
    }).toEqual({ fragment: fragmentBefore, docUnchanged: true })
  })

  it("stamps the resolved name onto a composer's node", () => {
    const editor = mount(new Editor({ extensions: createEditorExtensions({ placeholder: "" }), content: LINK_DOC }))

    stampLinkName(editor)

    expect(linkName(editor)).toBe("general")
  })
})
