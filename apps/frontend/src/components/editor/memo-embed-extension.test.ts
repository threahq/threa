import { afterEach, describe, it, expect } from "vitest"
import { Editor } from "@tiptap/core"
import type { MemoEmbedSummary } from "@threa/types"
import { createEditorExtensions } from "./editor-extensions"

/**
 * The `summary` attr is what lets a memo card render complete in the two places
 * the server's copy can't reach it: a sealed stream (the server sees only the
 * placeholder body) and an optimistic or offline send (no round trip yet). So
 * what matters here is that it survives the trip through the document.
 */

const editors: Editor[] = []

const SUMMARY: MemoEmbedSummary = {
  memoId: "memo_01ABC",
  title: "Switched theme to light",
  knowledgeType: "decision",
  memoType: "conversation",
  tags: ["settings", "preferences"],
  updatedAt: "2026-07-02T10:00:00.000Z",
}

function makeEditor(content = "") {
  const el = document.createElement("div")
  document.body.appendChild(el)
  const editor = new Editor({ element: el, extensions: createEditorExtensions({ placeholder: "x" }), content })
  editor.on("destroy", () => el.remove())
  editors.push(editor)
  return editor
}

function memoNodeAttrs(editor: Editor): Record<string, unknown> | null {
  let found: Record<string, unknown> | null = null
  editor.state.doc.descendants((node) => {
    if (node.type.name === "memoEmbed") found = node.attrs
    return !found
  })
  return found
}

// vitest keeps the jsdom document between cases, so an editor left mounted
// leaks its DOM into the next one.
afterEach(() => {
  while (editors.length) editors.pop()?.destroy()
})

describe("MemoEmbedExtension summary attr", () => {
  it("carries the summary given at insert time", () => {
    const editor = makeEditor()
    editor.commands.insertMemoEmbed({ memoId: "memo_01ABC", title: "Theme", summary: SUMMARY })

    expect(memoNodeAttrs(editor)).toMatchObject({ memoId: "memo_01ABC", title: "Theme", summary: SUMMARY })
  })

  it("defaults to no summary when inserted without one", () => {
    const editor = makeEditor()
    editor.commands.insertMemoEmbed({ memoId: "memo_01ABC" })

    expect(memoNodeAttrs(editor)).toMatchObject({ memoId: "memo_01ABC", summary: null })
  })

  // A chip copied out of one composer and pasted into another goes through HTML,
  // which is where a non-string attr silently becomes "[object Object]".
  it("round-trips the summary through HTML", () => {
    const source = makeEditor()
    source.commands.insertMemoEmbed({ memoId: "memo_01ABC", title: "Theme", summary: SUMMARY })

    const pasted = makeEditor(source.getHTML())

    expect(memoNodeAttrs(pasted)).toMatchObject({ memoId: "memo_01ABC", summary: SUMMARY })
  })

  it("survives a malformed summary attribute rather than failing to parse the document", () => {
    const pasted = makeEditor(
      '<p><span data-type="memo-embed" data-memo-id="memo_01ABC" data-title="Theme" data-summary="{not json"></span></p>'
    )

    expect(memoNodeAttrs(pasted)).toMatchObject({ memoId: "memo_01ABC", summary: null })
  })
})
