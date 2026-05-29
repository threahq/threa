import { afterEach, describe, it, expect } from "vitest"
import { Editor } from "@tiptap/core"
import { createEditorExtensions } from "../editor-extensions"
import { filterCommands } from "./use-command-suggestion"
import type { CommandItem } from "./types"

const INVITE: CommandItem = { name: "invite", description: "Invite users to this channel" }
const DISCUSS: CommandItem = {
  name: "discuss-with-ariadne",
  description: "Open a side-conversation",
  clientActionId: "discuss-with-ariadne",
}
const MEMO: CommandItem = {
  name: "memo",
  description: "Search and embed a memo",
  clientActionId: "memo-search",
  placement: "inline",
}
const ALL = [MEMO, INVITE, DISCUSS]

const editors: Editor[] = []

function makeEditor() {
  const extensions = createEditorExtensions({ placeholder: "x" })
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
  editor.commands.focus()
  for (const ch of text) editor.view.dispatch(editor.state.tr.insertText(ch))
}

function names(items: CommandItem[]) {
  return items.map((i) => i.name).sort()
}

describe("filterCommands placement gating", () => {
  it("shows whole-message and inline commands when the slash opens the message", () => {
    const editor = makeEditor()
    typeText(editor, "/")
    expect(names(filterCommands(ALL, "", editor))).toEqual(["discuss-with-ariadne", "invite", "memo"])
  })

  it("hides whole-message commands mid-sentence but keeps inline ones", () => {
    const editor = makeEditor()
    typeText(editor, "hello /")
    expect(names(filterCommands(ALL, "", editor))).toEqual(["memo"])
  })

  it("still narrows by query when the slash opens the message", () => {
    const editor = makeEditor()
    typeText(editor, "/inv")
    expect(names(filterCommands(ALL, "inv", editor))).toEqual(["invite"])
  })

  it("matches an inline command mid-sentence by query", () => {
    const editor = makeEditor()
    typeText(editor, "see /mem")
    expect(names(filterCommands(ALL, "mem", editor))).toEqual(["memo"])
  })

  it("returns whole-message commands when no editor context is available", () => {
    // Defensive fallback: without an editor we can't tell where the slash is, so
    // we don't hide message-level commands (the prior behavior).
    expect(names(filterCommands(ALL, ""))).toEqual(["discuss-with-ariadne", "invite", "memo"])
  })
})
