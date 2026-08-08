import { afterEach, describe, expect, it, vi } from "vitest"
import { Editor } from "@tiptap/core"
import { DOMParser as PMDOMParser, DOMSerializer, type Slice } from "@tiptap/pm/model"
import { NodeSelection, TextSelection } from "@tiptap/pm/state"
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

describe("attachment reference insertion", () => {
  it.each([
    ["Hello", "Hello "],
    ["Hello ", "Hello "],
    ["Hello:   ", "Hello:   "],
    ["", ""],
  ])("normalizes spacing before a chip inserted after %j", (input, expectedBeforeChip) => {
    const editor = new Editor({
      element: document.createElement("div"),
      extensions: createEditorExtensions({ placeholder: "Type a message..." }),
      content: {
        type: "doc",
        content: [{ type: "paragraph", content: input ? [{ type: "text", text: input }] : undefined }],
      },
    })
    openEditors.push(editor)
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, input.length + 1)))

    editor.commands.insertAttachmentReference(CHIP_ATTRS)

    const at = chipPos(editor)
    expect({
      beforeChip: editor.state.doc.textBetween(0, at),
      afterChip: editor.state.doc.textBetween(at + 1, at + 2),
    }).toEqual({ beforeChip: expectedBeforeChip, afterChip: " " })
  })

  it("inserts a picked batch atomically", () => {
    const editor = new Editor({
      element: document.createElement("div"),
      extensions: createEditorExtensions({ placeholder: "Type a message..." }),
      content: { type: "doc", content: [{ type: "paragraph" }] },
    })
    openEditors.push(editor)
    const onUpdate = vi.fn()
    editor.on("update", onUpdate)

    editor.commands.insertAttachmentReferences(
      ["temp_1", "temp_2", "temp_3"].map((id) => ({ ...CHIP_ATTRS, id, status: "uploading" }))
    )
    const ids: string[] = []
    editor.state.doc.descendants((node) => {
      if (node.type.name === "attachmentReference") ids.push(node.attrs.id as string)
    })

    expect({ ids, updateCalls: onUpdate.mock.calls.length }).toEqual({
      ids: ["temp_1", "temp_2", "temp_3"],
      updateCalls: 1,
    })
  })

  it("does not add a leading space after a hard break", () => {
    const editor = new Editor({
      element: document.createElement("div"),
      extensions: createEditorExtensions({ placeholder: "Type a message..." }),
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Hello" }, { type: "hardBreak" }],
          },
        ],
      },
    })
    openEditors.push(editor)
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 7)))

    editor.commands.insertAttachmentReference(CHIP_ATTRS)

    expect(editor.getJSON().content?.[0]?.content).toEqual([
      { type: "text", text: "Hello" },
      { type: "hardBreak" },
      { type: "attachmentReference", attrs: CHIP_ATTRS },
      { type: "text", text: " " },
    ])
  })

  it("inserts the chip at the current text selection", () => {
    const editor = new Editor({
      element: document.createElement("div"),
      extensions: createEditorExtensions({ placeholder: "Type a message..." }),
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "before after" }] }] },
    })
    openEditors.push(editor)
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 8)))

    editor.commands.insertAttachmentReference(CHIP_ATTRS)

    expect(editor.getJSON()).toEqual({
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
    })
  })
})

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
