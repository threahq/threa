import { afterEach, describe, it, expect } from "vitest"
import { Editor } from "@tiptap/core"
import { createEditorExtensions } from "../editor-extensions"
import { MemoSearchPluginKey } from "./memo-search-extension"
import { MEMO_SEARCH_SLASH_ACTION } from "./command-extension"
import type { CommandItem } from "./types"

const editors: Editor[] = []

afterEach(() => {
  while (editors.length) editors.pop()?.destroy()
})

const MEMO_ITEM: CommandItem = {
  name: "memo",
  description: "Search and embed a memo",
  clientActionId: MEMO_SEARCH_SLASH_ACTION,
}

function makeEditor() {
  let slashCommand: ((item: CommandItem) => void) | null = null
  const memoStarts: { query: string }[] = []

  const extensions = createEditorExtensions({
    placeholder: "x",
    commandSuggestion: {
      items: () => [MEMO_ITEM],
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
    memoSearchSuggestion: {
      items: () => [],
      render: () => ({
        onStart: (p) => memoStarts.push({ query: p.query }),
        onUpdate: (p) => memoStarts.push({ query: p.query }),
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
  return { editor, getSlashCommand: () => slashCommand, memoStarts }
}

function typeText(editor: Editor, text: string) {
  for (const ch of text) editor.view.dispatch(editor.state.tr.insertText(ch))
}

describe("/memo slash-menu discovery handoff", () => {
  it("selecting the /memo slash item types '/memo ' and activates the memo picker", async () => {
    const { editor, getSlashCommand, memoStarts } = makeEditor()
    editor.commands.focus()

    // Typing `/memo` opens the slash menu (memo item present); it must NOT yet
    // activate the memo-search trigger (that needs a trailing space).
    typeText(editor, "/memo")
    expect((MemoSearchPluginKey.getState(editor.state) as { active: boolean }).active).toBe(false)

    // The suggestion plugin's render `onStart`/`onUpdate` fire on a microtask
    // (after its internal `await items()`), so wait a tick before reading the
    // captured slash command.
    await new Promise((r) => setTimeout(r, 0))

    // Pick the "memo" entry from the slash menu.
    const command = getSlashCommand()
    expect(command, "slash command never captured").toBeTruthy()
    command!(MEMO_ITEM)
    await new Promise((r) => setTimeout(r, 0))

    // The chip was NOT inserted; instead the text handed off to the memo trigger.
    expect(editor.getText()).toBe("/memo ")
    const memoState = MemoSearchPluginKey.getState(editor.state) as { active: boolean; query: string | null }
    expect(memoState.active).toBe(true)
    expect(memoState.query).toBe("")
    expect(memoStarts.at(-1)?.query).toBe("")
  })
})
