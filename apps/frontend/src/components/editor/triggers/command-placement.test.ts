import { afterEach, describe, it, expect } from "vitest"
import { Editor } from "@tiptap/core"
import { createEditorExtensions } from "../editor-extensions"
import { filterCommands } from "./use-command-suggestion"
import type { CommandItem } from "./types"

const INVITE: CommandItem = { name: "invite", description: "Invite users to this channel" }
const DISCUSS: CommandItem = {
  name: "aside",
  description: "Open a side-conversation",
  clientActionId: "aside",
}
const MEMO: CommandItem = {
  name: "memo",
  description: "Search and embed a memo",
  clientActionId: "memo-search",
  placement: "inline",
}
const GIPHY: CommandItem = {
  name: "giphy",
  description: "Search and attach a GIF",
  clientActionId: "giphy",
  placement: "inline",
}
const SPAWN: CommandItem = {
  name: "spawn",
  description: "Spawn a coding session",
  args: [
    { name: "runtime", suggestions: [{ value: "pi" }] },
    { name: "/model", suggestions: [{ value: "opus" }] },
    { name: "/thinking", suggestions: [{ value: "high" }] },
  ],
}
const ALL = [MEMO, GIPHY, INVITE, DISCUSS]
const WITH_SPAWN = [...ALL, SPAWN]

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

function openWithCommand(editor: Editor, name: string) {
  editor.commands.focus()
  editor.commands.insertContent({ type: "slashCommand", attrs: { name } })
}

function names(items: CommandItem[]) {
  return items.map((i) => i.name).sort()
}

describe("filterCommands placement gating", () => {
  it("shows whole-message and inline commands when the slash opens the message", () => {
    const editor = makeEditor()
    typeText(editor, "/")
    expect(names(filterCommands(ALL, "", editor))).toEqual(["aside", "giphy", "invite", "memo"])
  })

  it("hides whole-message commands mid-sentence but keeps inline ones", () => {
    const editor = makeEditor()
    typeText(editor, "hello /")
    expect(names(filterCommands(ALL, "", editor))).toEqual(["giphy", "memo"])
  })

  it("matches the giphy command mid-sentence by query (available everywhere)", () => {
    const editor = makeEditor()
    typeText(editor, "look at this /gif")
    expect(names(filterCommands(ALL, "gif", editor))).toEqual(["giphy"])
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

  it("ranks name matches above description-only matches", () => {
    const editor = makeEditor()
    typeText(editor, "/invite")
    // SHOUT matches "invite" only in its description and is defined first;
    // INVITE matches on its visible name and must rank above it.
    const SHOUT: CommandItem = { name: "shout", description: "Invite everyone loudly" }
    const items = filterCommands([SHOUT, INVITE], "invite", editor)
    expect(items.map((i) => i.name)).toEqual(["invite", "shout"])
  })

  it("keeps whole-message commands when the slash opens a message already carrying a prompt", () => {
    // The prompt is typed first, then the command in front of it — the dispatch
    // reads the leading command either way, so the palette must too.
    const editor = makeEditor()
    typeText(editor, "write me a haiku")
    editor.commands.setTextSelection(1)
    typeText(editor, "/")
    expect(names(filterCommands(ALL, "", editor))).toEqual(["aside", "giphy", "invite", "memo"])
  })

  it("returns whole-message commands when no editor context is available", () => {
    // Defensive fallback: without an editor we can't tell where the slash is, so
    // we don't hide message-level commands (the prior behavior).
    expect(names(filterCommands(ALL, ""))).toEqual(["aside", "giphy", "invite", "memo"])
  })
})

describe("filterCommands argument gating", () => {
  it("offers no command for a slash that names one of the open command's flags", () => {
    const editor = makeEditor()
    openWithCommand(editor, "spawn")
    typeText(editor, " pi /model")
    expect(filterCommands(WITH_SPAWN, "model", editor)).toEqual([])
  })

  it("offers no command for a bare slash inside a command that takes flags", () => {
    const editor = makeEditor()
    openWithCommand(editor, "spawn")
    typeText(editor, " pi /")
    expect(filterCommands(WITH_SPAWN, "", editor)).toEqual([])
  })

  it("still offers inline commands for a slash that names no flag", () => {
    const editor = makeEditor()
    openWithCommand(editor, "spawn")
    typeText(editor, " pi /mem")
    expect(names(filterCommands(WITH_SPAWN, "mem", editor))).toEqual(["memo"])
  })

  it("leaves a command that declares no flags alone", () => {
    const editor = makeEditor()
    openWithCommand(editor, "aside")
    typeText(editor, " see /mem")
    expect(names(filterCommands(WITH_SPAWN, "mem", editor))).toEqual(["memo"])
  })
})
