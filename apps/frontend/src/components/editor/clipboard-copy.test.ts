import { describe, expect, it } from "vitest"
import { Editor } from "@tiptap/core"
import type { JSONContent } from "@tiptap/react"
import { NodeSelection } from "@tiptap/pm/state"
import { createEditorExtensions } from "./editor-extensions"
import { parseMarkdown } from "./editor-markdown"
import { serializeClipboardSlice } from "./clipboard-copy"

function createTestEditor(content: string | JSONContent) {
  const extensions = createEditorExtensions({
    placeholder: "Type a message...",
    mentionSuggestion: {
      items: () => [],
      render: () => ({ onStart: () => {}, onUpdate: () => {}, onExit: () => {}, onKeyDown: () => false }),
    },
  })

  return new Editor({
    element: document.createElement("div"),
    extensions,
    content:
      typeof content === "string"
        ? parseMarkdown(
            content,
            () => "user",
            () => null
          )
        : content,
  })
}

/** Absolute positions of a literal run of text inside the document. */
function findText(editor: Editor, needle: string): { from: number; to: number } {
  let found: { from: number; to: number } | null = null
  editor.state.doc.descendants((node, pos) => {
    if (found) return false
    if (!node.isText) return true
    const index = (node.text ?? "").indexOf(needle)
    if (index === -1) return true
    found = { from: pos + index, to: pos + index + needle.length }
    return false
  })
  if (!found) throw new Error(`Text not found in editor: ${needle}`)
  return found
}

/** What the editor writes to `text/plain` when the given run is copied. */
function copySelection(editor: Editor, needle: string): string {
  editor.commands.setTextSelection(findText(editor, needle))
  return serializeClipboardSlice(editor.state.selection.content(), editor.view)
}

function copyEverything(editor: Editor): string {
  editor.commands.selectAll()
  return serializeClipboardSlice(editor.state.selection.content(), editor.view)
}

describe("serializeClipboardSlice", () => {
  describe("block styling only when the selection contains a boundary", () => {
    it("copies text taken from inside a code block bare", () => {
      const editor = createTestEditor("```ts\nconst apiKey = 1\n```")

      expect(copySelection(editor, "apiKey")).toBe("apiKey")
    })

    it("copies multiple lines taken from inside a code block bare", () => {
      const editor = createTestEditor("```ts\nconst a = 1\nconst b = 2\n```")

      expect(copySelection(editor, "const a = 1\nconst b = 2")).toBe("const a = 1\nconst b = 2")
    })

    it("leaves markdown inside a code block untouched", () => {
      const editor = createTestEditor("```plaintext\n> Hi there\n```")

      expect(copySelection(editor, "there")).toBe("there")
    })

    it("keeps the fence when the whole block is selected across its boundaries", () => {
      const editor = createTestEditor("```ts\nconst apiKey = 1\n```")

      expect(copyEverything(editor)).toBe("```ts\nconst apiKey = 1\n```")
    })

    it("copies text taken from inside a blockquote without the quote marker", () => {
      const editor = createTestEditor("> quoted line")

      expect(copySelection(editor, "quoted")).toBe("quoted")
    })

    it("keeps quote markers when the whole quote is selected across its boundaries", () => {
      const editor = createTestEditor("> quoted line")

      expect(copyEverything(editor)).toBe("> quoted line")
    })

    it("drops the quote wrapper but keeps paragraph structure across a multi-paragraph quote", () => {
      const editor = createTestEditor({
        type: "doc",
        content: [
          {
            type: "blockquote",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "first line" }] },
              { type: "paragraph", content: [{ type: "text", text: "second line" }] },
            ],
          },
        ],
      })

      editor.commands.setTextSelection({
        from: findText(editor, "first").from,
        to: findText(editor, "second").to,
      })

      expect(serializeClipboardSlice(editor.state.selection.content(), editor.view)).toBe("first line\n\nsecond")
    })

    it("copies text taken from inside a heading without the hashes", () => {
      const editor = createTestEditor("## A heading")

      expect(copySelection(editor, "heading")).toBe("heading")
    })

    it("copies text taken from inside a list item without the bullet", () => {
      const editor = createTestEditor("- first item\n- second item")

      expect(copySelection(editor, "first")).toBe("first")
    })

    it("keeps bullets when the list is selected across its boundaries", () => {
      const editor = createTestEditor("- first item\n- second item")

      expect(copyEverything(editor)).toBe("- first item\n- second item")
    })

    it("keeps block styling when the selection crosses into a sibling block", () => {
      const editor = createTestEditor("```ts\nconst a = 1\n```\n\ntail paragraph")

      editor.commands.setTextSelection({
        from: findText(editor, "const a").from,
        to: findText(editor, "tail").to,
      })

      expect(serializeClipboardSlice(editor.state.selection.content(), editor.view)).toBe(
        "```ts\nconst a = 1\n```\n\ntail"
      )
    })
  })

  describe("inline marks only when the selection contains the run's boundaries", () => {
    it("copies part of a bold run without the bold markers", () => {
      const editor = createTestEditor("**bold words** tail")

      expect(copySelection(editor, "words")).toBe("words")
    })

    it("copies a whole bold run with the bold markers", () => {
      const editor = createTestEditor("**bold words** tail")

      expect(copySelection(editor, "bold words")).toBe("**bold words**")
    })

    it("copies part of an italic run without the italic markers", () => {
      const editor = createTestEditor("*Example a* tail")

      expect(copySelection(editor, "a")).toBe("a")
    })

    it("keeps marks on runs that sit entirely inside the selection", () => {
      const editor = createTestEditor("lead **bold** trail")

      editor.commands.setTextSelection({
        from: findText(editor, "ead").from,
        to: findText(editor, "trai").to,
      })

      expect(serializeClipboardSlice(editor.state.selection.content(), editor.view)).toBe("ead **bold** trai")
    })

    it("trims only the mark that straddles the edge", () => {
      const editor = createTestEditor("**bold `code` words** tail")

      expect(copySelection(editor, "words")).toBe("words")
      expect(copySelection(editor, "code")).toBe("`code`")
    })
  })

  describe("chips", () => {
    it("serializes an inline atom selected on its own", () => {
      const editor = createTestEditor("[@alice](user:usr_01ABC) said hi")
      let mentionPos = -1
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === "mention") mentionPos = pos
        return true
      })
      expect(mentionPos).toBeGreaterThanOrEqual(0)

      editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, mentionPos)))

      expect(serializeClipboardSlice(editor.state.selection.content(), editor.view)).toBe("[@alice](user:usr_01ABC)")
    })

    it("keeps chips when the whole message is copied", () => {
      const editor = createTestEditor("[@alice](user:usr_01ABC) said hi")

      expect(copyEverything(editor)).toBe("[@alice](user:usr_01ABC) said hi")
    })
  })
})
