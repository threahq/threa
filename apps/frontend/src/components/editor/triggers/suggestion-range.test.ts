import { afterEach, describe, it, expect } from "vitest"
import { Editor } from "@tiptap/core"
import type { SuggestionProps } from "@tiptap/suggestion"
import { createEditorExtensions } from "../editor-extensions"
import type { EmojiEntry } from "@threa/types"

const SHRUG: EmojiEntry = {
  shortcode: "shrug",
  emoji: "🤷",
  type: "native",
  group: "people",
  order: 0,
  aliases: ["shrug"],
  keywords: [],
}

const MENTIONABLE = { id: "usr_1", slug: "ada", name: "Ada", type: "user" as const }

const editors: Editor[] = []

/**
 * Holds the pick handler the popup was rendered with, which is what a finger
 * actually taps — captured at onStart, invoked later, exactly like a rendered
 * option's click handler.
 */
function makeEditor(trigger: "emoji" | "mention") {
  let command: ((item: unknown) => void) | null = null
  const render = () => ({
    onStart: (props: SuggestionProps<unknown>) => {
      command = props.command
    },
    onUpdate: (props: SuggestionProps<unknown>) => {
      command = props.command
    },
    onExit: () => {},
    onKeyDown: () => false,
  })

  const extensions = createEditorExtensions({
    placeholder: "x",
    ...(trigger === "emoji"
      ? { emojiSuggestion: { items: () => [SHRUG], render }, toEmoji: () => null }
      : { mentionSuggestion: { items: () => [MENTIONABLE], render } }),
  })

  const element = document.createElement("div")
  document.body.appendChild(element)
  const editor = new Editor({ element, extensions, content: "" })
  editor.on("destroy", () => element.remove())
  editors.push(editor)
  editor.commands.focus()
  return { editor, pick: () => command?.(trigger === "emoji" ? SHRUG : MENTIONABLE) }
}

function typeText(editor: Editor, text: string) {
  for (const char of text) editor.view.dispatch(editor.state.tr.insertText(char))
}

// The suggestion plugin hands the popup its pick handler asynchronously.
const popupRendered = () => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  while (editors.length) editors.pop()?.destroy()
})

describe("a pick after the doc moved under the popup", () => {
  it("replaces the emoji trigger's current text, not the text it was rendered with", async () => {
    const { editor, pick } = makeEditor("emoji")
    typeText(editor, ":shr")
    await popupRendered()

    // The keyboard's word-correction lands before the tap's handler runs, so
    // the popup's own range is a character short of the trigger text.
    typeText(editor, "u")
    pick()

    expect(editor.getText()).toBe("🤷 ")
  })

  it("replaces a mention trigger's current text too", async () => {
    const { editor, pick } = makeEditor("mention")
    typeText(editor, "@ad")
    await popupRendered()

    typeText(editor, "a")
    pick()

    expect(editor.getText()).toBe("@ada ")
  })
})
