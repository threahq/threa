import { afterEach, describe, it, expect } from "vitest"
import { Editor } from "@tiptap/core"
import { createEditorExtensions } from "../editor-extensions"
import { MemoSearchPluginKey } from "./memo-search-extension"

const editors: Editor[] = []

function makeEditor() {
  const extensions = createEditorExtensions({
    placeholder: "x",
    memoSearchSuggestion: {
      items: () => [],
      render: () => ({
        onStart() {},
        onUpdate() {},
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
  return editor
}

afterEach(() => {
  while (editors.length) editors.pop()?.destroy()
})

function typeText(editor: Editor, text: string) {
  for (const ch of text) editor.view.dispatch(editor.state.tr.insertText(ch))
}

function memoState(editor: Editor) {
  return MemoSearchPluginKey.getState(editor.state) as { active: boolean; query: string | null }
}

describe("MemoSearchExtension trigger matching", () => {
  it("does NOT activate on a bare /memo at the start of a block (deferred to slash palette)", () => {
    const editor = makeEditor()
    editor.commands.focus()
    typeText(editor, "/memo")
    expect(memoState(editor).active).toBe(false)
  })

  it("does NOT activate on a bare /memo mid-sentence (deferred to slash palette until a space follows)", () => {
    const editor = makeEditor()
    editor.commands.focus()
    typeText(editor, "hello /memo")
    expect(memoState(editor).active).toBe(false)
  })

  it("activates on /memo followed by a query and captures the multi-word query", () => {
    const editor = makeEditor()
    editor.commands.focus()
    typeText(editor, "hello /memo auth rewrite")
    const state = memoState(editor)
    expect(state.active).toBe(true)
    expect(state.query).toBe("auth rewrite")
  })

  it("activates after the trailing-space handoff from a start-of-block /memo", () => {
    const editor = makeEditor()
    editor.commands.focus()
    typeText(editor, "/memo ")
    const state = memoState(editor)
    expect(state.active).toBe(true)
    expect(state.query).toBe("")
  })

  it("does NOT activate inside inline code", () => {
    const editor = makeEditor()
    editor.commands.focus()
    editor.chain().focus().setMark("code").run()
    typeText(editor, "/memo auth")
    expect(memoState(editor).active).toBe(false)
  })

  it("does NOT activate when a backtick sits directly before /memo (`` `/memo`` )", () => {
    const editor = makeEditor()
    editor.commands.focus()
    typeText(editor, "see `/memo auth")
    expect(memoState(editor).active).toBe(false)
  })
})
