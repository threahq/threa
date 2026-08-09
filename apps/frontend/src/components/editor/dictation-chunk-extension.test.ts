import { afterEach, describe, expect, it } from "vitest"
import { Editor } from "@tiptap/core"
import type { JSONContent } from "@tiptap/react"
import { createEditorExtensions } from "./editor-extensions"
import { getDictationChunkPositions } from "./dictation-chunk-extension"

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

  it("inserts after a tracked chunk independent of the moved caret and hard-joins scalar splits", () => {
    editor = make(paragraph("typed"))
    editor.commands.setTextSelection(6)
    editor.commands.insertDictationChunk({ chunkId: "a", contentJson: paragraph("hel") })
    editor.commands.setTextSelection(1)
    editor.commands.insertDictationChunk({
      chunkId: "b",
      afterChunkId: "a",
      joinPrevious: true,
      contentJson: paragraph("lo"),
    })
    expect(editor.getText()).toBe("typed hello")
  })

  it("atomically collapses two adjacent chunks and tracks the result", () => {
    editor = make(paragraph(""))
    editor.commands.insertDictationChunk({ chunkId: "a", contentJson: paragraph("one") })
    editor.commands.insertDictationChunk({ chunkId: "b", afterChunkId: "a", contentJson: paragraph("two") })
    let status = ""
    expect(
      editor.commands.replaceDictationChunks({
        sources: [
          { chunkId: "a", throughRevision: 1 },
          { chunkId: "b", throughRevision: 2 },
        ],
        resultChunkId: "ab",
        contentJson: paragraph("combined"),
        onResult: (result) => (status = result),
      })
    ).toBe(true)
    expect({ status, text: editor.getText() }).toEqual({ status: "applied", text: "combined" })
    expect(editor.commands.replaceDictationChunk({ chunkId: "ab", contentJson: paragraph("toggle") })).toBe(true)
    expect(editor.getText()).toBe("toggle")
  })

  it("tracks structurally fitted list sources and atomically replaces their complete span", () => {
    editor = make(paragraph("Typed"))
    editor.commands.setTextSelection(6)
    expect(editor.commands.insertDictationChunk({ chunkId: "accepted-list", contentJson: list })).toBe(true)
    expect(
      editor.commands.insertDictationChunk({
        chunkId: "raw-tail",
        afterChunkId: "accepted-list",
        contentJson: paragraph("tail"),
      })
    ).toBe(true)
    const sources = getDictationChunkPositions(editor.state)
    expect(sources.map(({ chunkId, from, to }) => ({ chunkId, nonempty: from < to }))).toEqual([
      { chunkId: "accepted-list", nonempty: true },
      { chunkId: "raw-tail", nonempty: true },
    ])
    expect(editor.getJSON()).toEqual({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Typed" }] },
        ...list.content!,
        { type: "paragraph", content: [{ type: "text", text: "tail" }] },
      ],
    })

    let status = ""
    expect(
      editor.commands.replaceDictationChunks({
        sources: [
          { chunkId: "accepted-list", throughRevision: 1 },
          { chunkId: "raw-tail", throughRevision: 2 },
        ],
        resultChunkId: "combined",
        contentJson: list,
        onResult: (result) => (status = result),
      })
    ).toBe(true)
    expect(status).toBe("applied")
    expect(editor.getJSON()).toEqual({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Typed" }] }, ...list.content!],
    })
    expect(
      getDictationChunkPositions(editor.state).map(({ chunkId, from, to }) => ({ chunkId, nonempty: from < to }))
    ).toEqual([{ chunkId: "combined", nonempty: true }])
    expect(editor.commands.replaceDictationChunk({ chunkId: "combined", contentJson: paragraph("toggle") })).toBe(true)
    expect(editor.getText()).toBe("Typed toggle")
  })

  it("keeps exactly one outer space for one-source and hard-joined two-source v4 replacements", () => {
    editor = make(paragraph("Typed"))
    editor.commands.setTextSelection(6)
    editor.commands.insertDictationChunk({ chunkId: "a", contentJson: paragraph("hel") })
    let status = ""
    editor.commands.replaceDictationChunks({
      sources: [{ chunkId: "a", throughRevision: 1 }],
      resultChunkId: "a",
      contentJson: paragraph("hello"),
      onResult: (result) => (status = result),
    })
    expect({ status, text: editor.getText() }).toEqual({ status: "applied", text: "Typed hello" })

    editor.commands.insertDictationChunk({
      chunkId: "b",
      afterChunkId: "a",
      joinPrevious: true,
      contentJson: paragraph("world"),
    })
    editor.commands.replaceDictationChunks({
      sources: [
        { chunkId: "a", throughRevision: 1 },
        { chunkId: "b", throughRevision: 2 },
      ],
      resultChunkId: "ab",
      contentJson: paragraph("helloworld"),
      onResult: (result) => (status = result),
    })
    expect({ status, text: editor.getText() }).toEqual({ status: "applied", text: "Typed helloworld" })
    expect(editor.commands.replaceDictationChunk({ chunkId: "ab", contentJson: paragraph("rawtoggle") })).toBe(true)
    expect(editor.getText()).toBe("Typed rawtoggle")
  })

  it("rejects reversed, missing, duplicate, and invalid replacements without partial content changes", () => {
    editor = make(paragraph(""))
    editor.commands.insertDictationChunk({ chunkId: "a", contentJson: paragraph("one") })
    editor.commands.insertDictationChunk({ chunkId: "b", afterChunkId: "a", contentJson: paragraph("two") })
    const before = editor.getJSON()
    const attempt = (sources: Array<{ chunkId: string; throughRevision: number }>, contentJson = paragraph("bad")) => {
      let status = ""
      editor.commands.replaceDictationChunks({
        sources,
        resultChunkId: "result",
        contentJson,
        onResult: (s) => (status = s),
      })
      return status
    }
    expect(
      attempt([
        { chunkId: "b", throughRevision: 2 },
        { chunkId: "a", throughRevision: 1 },
      ])
    ).toBe("non_contiguous")
    expect(attempt([{ chunkId: "missing", throughRevision: 1 }])).toBe("missing")
    expect(
      attempt([
        { chunkId: "a", throughRevision: 1 },
        { chunkId: "a", throughRevision: 1 },
      ])
    ).toBe("invalid")
    expect(attempt([{ chunkId: "a", throughRevision: 1 }], { type: "nope" })).toBe("invalid")
    expect(editor.getJSON()).toEqual(before)
  })

  it("reports malformed runtime sources invalid exactly once without throwing or mutating tracking", () => {
    editor = make(paragraph(""))
    editor.commands.insertDictationChunk({ chunkId: "a", contentJson: paragraph("one") })
    const before = editor.getJSON()
    const malformed: unknown[] = [null, {}, [null], [{ chunkId: "a", throughRevision: 1.5 }]]
    for (const sources of malformed) {
      const statuses: string[] = []
      expect(() =>
        editor.commands.replaceDictationChunks({
          sources: sources as never,
          resultChunkId: "result",
          contentJson: paragraph("bad"),
          onResult: (status) => statuses.push(status),
        })
      ).not.toThrow()
      expect({ statuses, doc: editor.getJSON() }).toEqual({ statuses: ["invalid"], doc: before })
    }
    const contentStatuses: string[] = []
    expect(() =>
      editor.commands.replaceDictationChunks({
        sources: [{ chunkId: "a", throughRevision: 1 }],
        resultChunkId: "result",
        contentJson: null as never,
        onResult: (status) => contentStatuses.push(status),
      })
    ).not.toThrow()
    expect({ contentStatuses, doc: editor.getJSON() }).toEqual({ contentStatuses: ["invalid"], doc: before })
    expect(editor.commands.replaceDictationChunk({ chunkId: "a", contentJson: paragraph("still tracked") })).toBe(true)
  })

  it("rejects result collisions and intervening user content without partial mutation", () => {
    editor = make(paragraph(""))
    editor.commands.insertDictationChunk({ chunkId: "a", contentJson: paragraph("one") })
    editor.commands.insertDictationChunk({ chunkId: "b", afterChunkId: "a", contentJson: paragraph("two") })
    editor.commands.insertDictationChunk({ chunkId: "independent", afterChunkId: "b", contentJson: paragraph("three") })
    const beforeCollision = editor.getJSON()
    let status = ""
    editor.commands.replaceDictationChunks({
      sources: [{ chunkId: "a", throughRevision: 1 }],
      resultChunkId: "independent",
      contentJson: paragraph("bad"),
      onResult: (result) => (status = result),
    })
    expect({ status, doc: editor.getJSON() }).toEqual({ status: "invalid", doc: beforeCollision })

    editor.commands.setTextSelection(5)
    editor.commands.insertContent("USER")
    const edited = editor.getJSON()
    editor.commands.replaceDictationChunks({
      sources: [
        { chunkId: "a", throughRevision: 1 },
        { chunkId: "b", throughRevision: 2 },
      ],
      resultChunkId: "ab",
      contentJson: paragraph("combined"),
      onResult: (result) => (status = result),
    })
    expect({ status, doc: editor.getJSON() }).toEqual({ status: "locked", doc: edited })
  })

  it("keeps a locked predecessor and appends the next independent source after it", () => {
    editor = make(paragraph(""))
    editor.commands.insertDictationChunk({ chunkId: "a", contentJson: paragraph("raw") })
    editor.commands.setTextSelection(2)
    editor.commands.insertContent("EDIT ")
    const edited = editor.getText()
    expect(
      editor.commands.insertDictationChunk({ chunkId: "b", afterChunkId: "a", contentJson: paragraph("next") })
    ).toBe(true)
    expect(
      editor.commands.insertDictationChunk({ chunkId: "c", afterChunkId: "b", contentJson: paragraph("independent") })
    ).toBe(true)
    expect(editor.getText()).toBe(`${edited} next independent`)
    expect(editor.commands.replaceDictationChunk({ chunkId: "a", contentJson: paragraph("overwrite") })).toBe(false)
    expect(editor.commands.replaceDictationChunk({ chunkId: "b", contentJson: paragraph("polished next") })).toBe(true)
    expect(
      editor.commands.replaceDictationChunk({ chunkId: "c", contentJson: paragraph("polished independent") })
    ).toBe(true)
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
    expect(editor.commands.insertDictationChunk({ chunkId: "take", contentJson: paragraph("continued") })).toBe(true)
    expect(editor.commands.insertDictationChunk({ chunkId: "take", contentJson: paragraph("again") })).toBe(true)
    expect(editor.getText()).not.toBe(beforeEdit)
    expect(editor.getText()).toBe(`${edited} continued again`)
    expect(editor.commands.replaceDictationChunk({ chunkId: "take", contentJson: paragraph("overwrite") })).toBe(false)
  })
})
