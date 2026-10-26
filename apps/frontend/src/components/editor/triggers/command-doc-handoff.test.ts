import { afterEach, describe, it, expect } from "vitest"
import { Editor } from "@tiptap/core"
import { createEditorExtensions } from "../editor-extensions"
import { DocSearchPluginKey } from "./doc-search-extension"
import { DOC_SEARCH_SLASH_ACTION } from "./command-extension"
import type { CommandItem } from "./types"

const editors: Editor[] = []

afterEach(() => {
  while (editors.length) editors.pop()?.destroy()
})

const DOC_ITEM: CommandItem = {
  name: "doc",
  description: "Link a doc",
  clientActionId: DOC_SEARCH_SLASH_ACTION,
}

function makeEditor() {
  let slashCommand: ((item: CommandItem) => void) | null = null
  const docStarts: { query: string }[] = []

  const extensions = createEditorExtensions({
    placeholder: "x",
    commandSuggestion: {
      items: () => [DOC_ITEM],
      render: () => ({
        onStart: (p) => {
          slashCommand = p.command
        },
        onUpdate: (p) => {
          slashCommand = p.command
        },
        onExit() {},
        onKeyDown: () => false,
      }),
    },
    docSearchSuggestion: {
      items: () => [],
      render: () => ({
        onStart: (p) => docStarts.push({ query: p.query }),
        onUpdate: (p) => docStarts.push({ query: p.query }),
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
  return { editor, getSlashCommand: () => slashCommand, docStarts }
}

function typeText(editor: Editor, text: string) {
  for (const ch of text) editor.view.dispatch(editor.state.tr.insertText(ch))
}

describe("/doc slash-menu discovery handoff", () => {
  it("should type '/doc ' and activate the doc picker when the doc slash item is selected", async () => {
    const { editor, getSlashCommand, docStarts } = makeEditor()
    editor.commands.focus()

    typeText(editor, "/doc")
    expect((DocSearchPluginKey.getState(editor.state) as { active: boolean }).active).toBe(false)

    // The suggestion plugin renders on a microtask, after its internal `await items()`.
    await new Promise((r) => setTimeout(r, 0))

    const command = getSlashCommand()
    expect(command, "slash command never captured").toBeTruthy()
    command!(DOC_ITEM)
    await new Promise((r) => setTimeout(r, 0))

    expect(editor.getText()).toBe("/doc ")
    const docState = DocSearchPluginKey.getState(editor.state) as { active: boolean; query: string | null }
    expect({ active: docState.active, query: docState.query, lastStart: docStarts.at(-1)?.query }).toEqual({
      active: true,
      query: "",
      lastStart: "",
    })
  })
})
