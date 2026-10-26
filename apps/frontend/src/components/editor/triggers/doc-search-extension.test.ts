import { afterEach, describe, it, expect } from "vitest"
import { Editor } from "@tiptap/core"
import { createEditorExtensions } from "../editor-extensions"
import { DocSearchPluginKey } from "./doc-search-extension"
import type { DocSuggestionItem } from "./use-doc-suggestion"

const editors: Editor[] = []

const PLAN: DocSuggestionItem = {
  id: "stream_plan",
  displayName: "Launch plan",
  parentStreamId: "stream_host",
  createdAt: "2026-10-01T00:00:00.000Z",
}

function makeEditor() {
  let pick: ((item: DocSuggestionItem) => void) | null = null
  const extensions = createEditorExtensions({
    placeholder: "x",
    docSearchSuggestion: {
      items: () => [PLAN],
      render: () => ({
        onStart: (props) => {
          pick = props.command
        },
        onUpdate: (props) => {
          pick = props.command
        },
        onExit() {},
        onKeyDown: () => false,
      }),
    },
  })

  const el = document.createElement("div")
  document.body.appendChild(el)
  const editor = new Editor({ element: el, extensions, content: "" })
  editor.on("destroy", () => el.remove())
  editors.push(editor)
  return { editor, getPick: () => pick }
}

afterEach(() => {
  while (editors.length) editors.pop()?.destroy()
})

function typeText(editor: Editor, text: string) {
  for (const ch of text) editor.view.dispatch(editor.state.tr.insertText(ch))
}

function docState(editor: Editor) {
  return DocSearchPluginKey.getState(editor.state) as { active: boolean; query: string | null }
}

describe("DocSearchExtension trigger matching", () => {
  it("should not activate when a bare /doc has no trailing space", () => {
    const { editor } = makeEditor()
    editor.commands.focus()
    typeText(editor, "hello /doc")
    expect(docState(editor).active).toBe(false)
  })

  it("should capture the multi-word query when /doc is followed by one mid-sentence", () => {
    const { editor } = makeEditor()
    editor.commands.focus()
    typeText(editor, "hello /doc launch plan")
    expect(docState(editor)).toMatchObject({ active: true, query: "launch plan" })
  })

  it("should activate with an empty query when the palette hands off /doc and a space", () => {
    const { editor } = makeEditor()
    editor.commands.focus()
    typeText(editor, "/doc ")
    expect(docState(editor)).toMatchObject({ active: true, query: "" })
  })

  it("should not activate when typed inside inline code", () => {
    const { editor } = makeEditor()
    editor.commands.focus()
    editor.chain().focus().setMark("code").run()
    typeText(editor, "/doc plan")
    expect(docState(editor).active).toBe(false)
  })

  it("should not activate when a backtick sits directly before /doc", () => {
    const { editor } = makeEditor()
    editor.commands.focus()
    typeText(editor, "see `/doc plan")
    expect(docState(editor).active).toBe(false)
  })

  it("should replace the typed trigger with a doc chip when a doc is picked", async () => {
    const { editor, getPick } = makeEditor()
    editor.commands.focus()
    typeText(editor, "see /doc lau")
    await new Promise((r) => setTimeout(r, 0))

    getPick()!(PLAN)

    expect(editor.getJSON().content?.[0]?.content).toEqual([
      { type: "text", text: "see " },
      { type: "docEmbed", attrs: { docId: "stream_plan", blockId: null, title: "Launch plan" } },
      { type: "text", text: " " },
    ])
  })

  it("should carry the caret's bold onto the chip when a doc is picked inside bold text", async () => {
    const { editor, getPick } = makeEditor()
    editor.chain().focus().setMark("bold").run()
    typeText(editor, "see /doc lau")
    await new Promise((r) => setTimeout(r, 0))

    getPick()!(PLAN)

    const bold = [{ type: "bold" }]
    expect(editor.getJSON().content?.[0]?.content).toEqual([
      { type: "text", text: "see ", marks: bold },
      { type: "docEmbed", attrs: { docId: "stream_plan", blockId: null, title: "Launch plan" }, marks: bold },
      { type: "text", text: " ", marks: bold },
    ])
  })
})
