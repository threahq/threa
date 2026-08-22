import { describe, expect, it } from "vitest"
import { Editor } from "@tiptap/core"
import type { JSONContent } from "@tiptap/react"
import { parseMarkdown } from "@threa/prosemirror"
import { createEditorExtensions } from "./editor-extensions"
import { serializeToMarkdown } from "./editor-markdown"

function agentDoc(text = "Two options."): JSONContent {
  return {
    type: "doc",
    content: [
      {
        type: "agentBlock",
        attrs: { authorId: "persona_01ARIADNE", authorName: "Ariadne", sourceAsideId: "stream_01ASIDE" },
        content: [{ type: "paragraph", content: [{ type: "text", text }] }],
      },
    ],
  }
}

function createEditor(content: JSONContent): Editor {
  const element = document.createElement("div")
  document.body.append(element)
  const editor = new Editor({ element, extensions: createEditorExtensions({ placeholder: "" }), content })
  editor.on("destroy", () => element.remove())
  return editor
}

describe("agentBlock in the composer", () => {
  it("keeps the node and its attribution when the text inside is rewritten", () => {
    const editor = createEditor(agentDoc())
    // Select the body text and type over it — the edit a user makes when they
    // reword what the agent wrote before sending it.
    editor.commands.setTextSelection({ from: 2, to: editor.state.doc.content.size - 2 })
    editor.commands.insertContent("My own wording.")

    const block = (editor.getJSON() as JSONContent).content?.[0]
    expect({ type: block?.type, attrs: block?.attrs, text: block?.content?.[0]?.content?.[0]?.text }).toEqual({
      type: "agentBlock",
      attrs: { authorId: "persona_01ARIADNE", authorName: "Ariadne", sourceAsideId: "stream_01ASIDE" },
      text: "My own wording.",
    })
    editor.destroy()
  })

  it("round-trips through the composer's markdown serializer", () => {
    const editor = createEditor(agentDoc())
    const markdown = serializeToMarkdown(editor.getJSON() as JSONContent)
    expect(markdown).toBe("> — [Ariadne](agent:persona_01ARIADNE/stream_01ASIDE)\n>\n> Two options.")
    expect(parseMarkdown(markdown)).toEqual(agentDoc())
    editor.destroy()
  })
})
