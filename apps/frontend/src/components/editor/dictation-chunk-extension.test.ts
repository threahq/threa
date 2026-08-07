import { afterEach, describe, expect, it } from "vitest"
import { Editor } from "@tiptap/core"
import type { JSONContent } from "@tiptap/react"
import { createEditorExtensions } from "./editor-extensions"

const paragraph = (text: string): JSONContent => ({
  type: "doc",
  content: [{ type: "paragraph", ...(text ? { content: [{ type: "text", text }] } : {}) }],
})
const list: JSONContent = {
  type: "doc",
  content: [
    {
      type: "bulletList",
      content: ["one", "two"].map((text) => ({
        type: "listItem",
        content: [{ type: "paragraph", content: [{ type: "text", text }] }],
      })),
    },
  ],
}

function make(content: JSONContent = paragraph("before after")) {
  const element = document.createElement("div")
  document.body.append(element)
  const editor = new Editor({ element, extensions: createEditorExtensions({ placeholder: "" }), content })
  editor.on("destroy", () => element.remove())
  return editor
}

let editor: Editor
afterEach(() => editor?.destroy())

describe("structured dictation chunks", () => {
  it("replaces the selection and inserts a naturally spaced inline paragraph", () => {
    editor = make()
    editor.commands.setTextSelection({ from: 8, to: 13 })
    expect(editor.commands.insertDictationChunk({ chunkId: "take", contentJson: paragraph("hello") })).toBe(true)
    expect(editor.getText()).toBe("before hello")
  })

  it("preserves boundary spacing across cumulative insertion, replacement, and toggles", () => {
    editor = make(paragraph("Typed"))
    editor.commands.setTextSelection(6)
    editor.commands.insertDictationChunk({ chunkId: "take", contentJson: paragraph("hello") })
    editor.commands.insertDictationChunk({ chunkId: "take", contentJson: paragraph("world") })
    expect(editor.getText()).toBe("Typed hello world")

    editor.commands.replaceDictationChunk({ chunkId: "take", contentJson: paragraph("hello polished world") })
    expect(editor.getText()).toBe("Typed hello polished world")
    editor.commands.replaceDictationChunk({ chunkId: "take", contentJson: paragraph("hello world") })
    expect(editor.getText()).toBe("Typed hello world")
  })

  it("replaces cumulative content with multiple paragraphs without corrupting its range", () => {
    editor = make(paragraph("Typed"))
    editor.commands.setTextSelection(6)
    editor.commands.insertDictationChunk({ chunkId: "take", contentJson: paragraph("first") })
    editor.commands.insertDictationChunk({ chunkId: "take", contentJson: paragraph("second") })
    const multiBlock: JSONContent = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "first polished" }] },
        { type: "paragraph", content: [{ type: "text", text: "second polished" }] },
      ],
    }
    expect(editor.commands.replaceDictationChunk({ chunkId: "take", contentJson: multiBlock })).toBe(true)
    expect(editor.getText()).toBe("Typed first polished\n\nsecond polished")
    expect(editor.commands.replaceDictationChunk({ chunkId: "take", contentJson: paragraph("first second") })).toBe(
      true
    )
    expect(editor.getText()).toBe("Typed first second")
  })

  it("round-trips exact raw and polished JSON including marks", () => {
    const raw: JSONContent = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "raw" }] }] }
    const polished: JSONContent = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", marks: [{ type: "bold" }], text: "polished" }] }],
    }
    editor = make(paragraph(""))
    editor.commands.insertDictationChunk({ chunkId: "take", contentJson: raw })
    editor.commands.replaceDictationChunk({ chunkId: "take", contentJson: polished })
    expect(editor.getJSON()).toEqual(polished)
    editor.commands.replaceDictationChunk({ chunkId: "take", contentJson: raw })
    expect(editor.getJSON()).toEqual(raw)
  })

  it("replaces a selection spanning blocks on first insertion", () => {
    editor = make({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "one" }] },
        { type: "paragraph", content: [{ type: "text", text: "two" }] },
      ],
    })
    editor.commands.setTextSelection({ from: 2, to: 8 })
    editor.commands.insertDictationChunk({ chunkId: "take", contentJson: paragraph("hello") })
    expect(editor.getText()).toBe("o helloo")
  })

  it("preserves complete lists and surrounding text across replacement and toggles", () => {
    editor = make()
    editor.commands.setTextSelection(8)
    editor.commands.insertDictationChunk({ chunkId: "take", contentJson: list })
    expect(editor.getJSON()).toMatchObject({
      content: [
        { type: "paragraph" },
        { type: "bulletList", content: [{ type: "listItem" }, { type: "listItem" }] },
        { type: "paragraph" },
      ],
    })
    expect(editor.getText()).not.toContain("-")
    expect(editor.commands.replaceDictationChunk({ chunkId: "take", contentJson: paragraph("raw words") })).toBe(true)
    expect(editor.commands.replaceDictationChunk({ chunkId: "take", contentJson: list })).toBe(true)
    expect(editor.getJSON().content?.[1]).toMatchObject({
      type: "bulletList",
      content: [{ type: "listItem" }, { type: "listItem" }],
    })
  })

  it("maps adjacent edits but tombstones a chunk after an inside edit", () => {
    editor = make(paragraph("typed"))
    editor.commands.setTextSelection(6)
    editor.commands.insertDictationChunk({ chunkId: "take", contentJson: paragraph("hello") })
    editor.commands.setTextSelection(1)
    editor.commands.insertContent("X")
    expect(editor.commands.replaceDictationChunk({ chunkId: "take", contentJson: paragraph("hello world") })).toBe(true)
    const beforeEdit = editor.getText()
    editor.commands.setTextSelection(9)
    editor.commands.insertContent("E")
    const edited = editor.getText()
    expect(editor.commands.replaceDictationChunk({ chunkId: "take", contentJson: list })).toBe(false)
    expect(editor.commands.insertDictationChunk({ chunkId: "take", contentJson: paragraph("resurrected") })).toBe(false)
    expect(editor.getText()).not.toBe(beforeEdit)
    expect(editor.getText()).toBe(edited)
  })
})
