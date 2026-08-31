import { describe, it, expect, afterEach } from "vitest"
import { act, render } from "@testing-library/react"
import { Editor } from "@tiptap/core"
import Document from "@tiptap/extension-document"
import Paragraph from "@tiptap/extension-paragraph"
import Text from "@tiptap/extension-text"
import type { EmojiEntry } from "@threa/types"
import { useEmojiSuggestion } from "./use-emoji-suggestion"
import { EmojiExtension } from "./emoji-extension"

function make(shortcode: string, order: number): EmojiEntry {
  return { shortcode, emoji: `E${order}`, type: "native", group: "smileys", order, aliases: [shortcode], keywords: [] }
}

const EMOJIS = [make("smile", 0), make("smiley", 1), make("smirk", 2)]

let editor: Editor | null = null
let active = false

function Harness() {
  const { suggestionConfig, renderEmojiGrid, isActive } = useEmojiSuggestion({ emojis: EMOJIS, emojiWeights: {} })
  active = isActive
  if (!editor) {
    const element = document.createElement("div")
    document.body.appendChild(element)
    editor = new Editor({
      element,
      extensions: [
        Document,
        Paragraph,
        Text,
        EmojiExtension.configure({ suggestion: suggestionConfig, toEmoji: () => null }),
      ],
      content: "<p></p>",
    })
  }
  return <>{renderEmojiGrid()}</>
}

afterEach(() => {
  editor?.destroy()
  editor = null
  active = false
})

const settle = () =>
  act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

const pickHighlighted = () =>
  editor!.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))

async function openPicker() {
  render(<Harness />)
  await act(async () => {
    editor!.commands.insertContent(":sm")
  })
  await settle()
  expect(active).toBe(true)
}

describe("emoji suggestion lifecycle", () => {
  it("drops the picker after a pick", async () => {
    await openPicker()

    await act(async () => {
      pickHighlighted()
    })
    await settle()

    expect(active).toBe(false)
    expect(document.querySelector("[data-emoji-grid]")).toBeNull()
  })

  it("drops the picker when a suggestion update resolves after the pick", async () => {
    await openPicker()

    // What a phone keyboard produces: its pending text change reaches the
    // editor in the same task as the pick, so the suggestion plugin's async
    // update lands after the pick has already ended the suggestion.
    await act(async () => {
      editor!.commands.insertContent("i")
      pickHighlighted()
    })
    await settle()

    expect(active).toBe(false)
    expect(document.querySelector("[data-emoji-grid]")).toBeNull()
  })

  it("keeps the picker while the suggestion is still running", async () => {
    await openPicker()

    await act(async () => {
      editor!.commands.insertContent("i")
    })
    await settle()

    expect(active).toBe(true)
  })
})
