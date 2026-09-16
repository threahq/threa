import { afterEach, describe, it, expect } from "vitest"
import { Editor } from "@tiptap/core"
import { createEditorExtensions } from "../editor-extensions"
import { argNames } from "@/lib/markdown/command-list-context"
import { chipBase, commandFlagChipStyle, commandValueStyle } from "@/lib/markdown/chip-styles"
import type { CommandArgumentInfo } from "@threahq/types"

const CLAUDE_MODELS = [{ value: "opus", label: "Opus" }]
const PI_MODELS = [{ value: "openai-codex/gpt-5.6-luna", label: "GPT-5.6 Luna" }]
const SPAWN_ARGS: CommandArgumentInfo[] = [
  {
    name: "runtime",
    suggestions: [
      {
        value: "claude",
        label: "Claude Code",
        args: [
          { name: "/model", suggestions: CLAUDE_MODELS },
          { name: "/thinking", suggestions: [{ value: "low" }, { value: "high" }] },
        ],
      },
      {
        value: "pi",
        label: "Pi",
        args: [
          { name: "/model", suggestions: PI_MODELS },
          { name: "/thinking", suggestions: [{ value: "off" }, { value: "medium" }] },
        ],
      },
    ],
  },
  { name: "/model", suggestions: CLAUDE_MODELS },
  { name: "/thinking", suggestions: [{ value: "low" }, { value: "high" }] },
  { name: "name", required: true },
]

const editors: Editor[] = []

afterEach(() => {
  while (editors.length) editors.pop()?.destroy()
})

function openWith(command: string, text: string, pickable = true) {
  const el = document.createElement("div")
  document.body.appendChild(el)
  const editor = new Editor({
    element: el,
    extensions: createEditorExtensions({
      placeholder: "x",
      commandArgsFor: (name) => (pickable && name === "spawn" ? argNames(SPAWN_ARGS) : null),
    }),
    content: "",
  })
  editor.on("destroy", () => el.remove())
  editors.push(editor)
  editor.view.dom.focus()
  editor.commands.focus()
  editor.commands.insertContent({ type: "slashCommand", attrs: { name: command } })
  for (const ch of text) editor.view.dispatch(editor.state.tr.insertText(ch))
  return editor
}

const valueChipClass = `${chipBase} bg-muted font-mono ${commandValueStyle} pl-0 rounded-l-none`

// Exact class match, so the `/command` node's own chip — same gold styling —
// is not counted as a decoration.
function flagChips(editor: Editor): { flag: string; value: string }[] {
  return [...editor.view.dom.querySelectorAll("span")]
    .filter((el) => el.className === `${chipBase} ${commandFlagChipStyle} pr-0 rounded-r-none`)
    .map((el) => {
      const next = el.nextElementSibling
      return { flag: el.textContent?.trim() ?? "", value: next?.className === valueChipClass ? (next.textContent ?? "") : "" }
    })
}

describe("CommandArgDecoration", () => {
  it("chips every flag with its value, leaving free text as prose", () => {
    const editor = openWith("spawn", " pi /model openai-codex/gpt-5.6-luna /thinking medium fix it")
    expect(flagChips(editor)).toEqual([
      { flag: "/model", value: "openai-codex/gpt-5.6-luna" },
      { flag: "/thinking", value: "medium" },
    ])
    expect(editor.view.dom.textContent).toContain("fix it")
    for (const chip of flagChips(editor)) expect(`${chip.flag} ${chip.value}`).not.toContain("fix it")
  })

  it("joins the leading positional value to the command chip, space included", () => {
    const editor = openWith("spawn", " pi /thinking medium")
    const chip = editor.view.dom.querySelector("[data-type='slashCommand']")
    expect(chip?.className).toContain("pr-0 rounded-r-none")
    expect(chip?.nextElementSibling?.className).toBe(valueChipClass)
    expect(chip?.nextElementSibling?.textContent).toBe(" pi")
    expect(flagChips(editor)).toEqual([{ flag: "/thinking", value: "medium" }])
  })

  it("leaves the command chip whole when no positional value follows", () => {
    const editor = openWith("spawn", " /thinking medium")
    expect(editor.view.dom.querySelector("[data-type='slashCommand']")?.className).not.toContain("rounded-r-none")
  })

  it("keeps its spans aligned across an inline leaf node", () => {
    const editor = openWith("spawn", " pi ")
    editor.commands.insertContent({ type: "mention", attrs: { id: "usr_1", slug: "kris" } })
    for (const ch of " /thinking medium go") editor.view.dispatch(editor.state.tr.insertText(ch))
    expect(flagChips(editor)).toEqual([{ flag: "/thinking", value: "medium" }])
  })

  it("draws nothing for a command that declares no arguments", () => {
    const editor = openWith("spawn", " pi /model opus", false)
    expect(flagChips(editor)).toEqual([])
  })
})
