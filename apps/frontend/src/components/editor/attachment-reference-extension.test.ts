import { afterEach, describe, expect, it } from "vitest"
import { Editor } from "@tiptap/core"
import { DOMParser as PMDOMParser, DOMSerializer, type Slice } from "@tiptap/pm/model"
import { NodeSelection } from "@tiptap/pm/state"
import { createEditorExtensions } from "./editor-extensions"
import type { AttachmentReferenceAttrs } from "./attachment-reference-extension"

const CHIP_ATTRS: AttachmentReferenceAttrs = {
  id: "att_01ABC",
  filename: "notes.txt",
  mimeType: "text/plain",
  sizeBytes: 12,
  status: "uploaded",
  imageIndex: null,
  error: null,
}

/**
 * Editors are torn down after each test: a live view keeps a DOMObserver
 * timeout that fires after the test environment is gone, which vitest reports
 * as an uncaught `document is not defined` and fails the run.
 */
const openEditors: Editor[] = []

afterEach(() => {
  while (openEditors.length > 0) {
    openEditors.pop()?.destroy()
  }
})

function createEditorWithChip() {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: createEditorExtensions({ placeholder: "Type a message..." }),
    content: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "before " },
            { type: "attachmentReference", attrs: CHIP_ATTRS },
            { type: "text", text: " after" },
          ],
        },
      ],
    },
  })
  openEditors.push(editor)
  return editor
}

function chipPos(editor: Editor): number {
  let pos = -1
  editor.state.doc.descendants((node, at) => {
    if (node.type.name === "attachmentReference") pos = at
    return true
  })
  if (pos < 0) throw new Error("Chip not found")
  return pos
}

/**
 * The clipboard's `text/html` flavour, the one an in-app paste restores the
 * document from. ProseMirror builds it with the schema's `renderHTML`.
 */
function clipboardHtml(editor: Editor, slice: Slice): string {
  const dom = DOMSerializer.fromSchema(editor.schema).serializeFragment(slice.content)
  const wrapper = document.createElement("div")
  wrapper.appendChild(dom)
  return wrapper.innerHTML
}

function pasteHtml(editor: Editor, html: string): Slice {
  const wrapper = document.createElement("div")
  wrapper.innerHTML = html
  return PMDOMParser.fromSchema(editor.schema).parseSlice(wrapper)
}

describe("attachment reference clipboard roundtrip", () => {
  it("serializes a chip selected on its own and parses it back with its attributes", () => {
    const editor = createEditorWithChip()
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, chipPos(editor))))

    const parsed = pasteHtml(editor, clipboardHtml(editor, editor.state.selection.content()))

    expect(parsed.content.firstChild?.attrs).toEqual(CHIP_ATTRS)
  })

  it("serializes a text range that contains a chip", () => {
    const editor = createEditorWithChip()
    editor.commands.selectAll()

    const parsed = pasteHtml(editor, clipboardHtml(editor, editor.state.selection.content()))

    expect(parsed.content.toJSON()).toEqual([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "before " },
          { type: "attachmentReference", attrs: CHIP_ATTRS },
          { type: "text", text: " after" },
        ],
      },
    ])
  })
})
