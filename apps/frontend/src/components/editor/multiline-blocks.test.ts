import { describe, expect, it } from "vitest"
import { Editor } from "@tiptap/core"
import type { JSONContent } from "@tiptap/react"
import { createEditorExtensions } from "./editor-extensions"
import { serializeToMarkdown, parseMarkdown } from "./editor-markdown"
import { NodeSelection } from "@tiptap/pm/state"
import {
  deleteAdjacentInlineAtom,
  handleBeforeInputAtomDelete,
  handleBeforeInputGraphemeDelete,
  handleBeforeInputKeyboardPaste,
  handleBeforeInputNewline,
  insertPastedText,
  toggleMultilineBlock,
} from "./multiline-blocks"

function createTestEditor(content: string | JSONContent) {
  // Enable mention + emoji extensions so tests can build docs with those atoms.
  // The suggestion stubs are inert; we only need the schemas registered.
  const extensions = createEditorExtensions({
    placeholder: "Type a message...",
    mentionSuggestion: {
      items: () => [],
      render: () => ({ onStart: () => {}, onUpdate: () => {}, onExit: () => {}, onKeyDown: () => false }),
    },
    channelSuggestion: {
      items: () => [],
      render: () => ({ onStart: () => {}, onUpdate: () => {}, onExit: () => {}, onKeyDown: () => false }),
    },
    emojiSuggestion: {
      items: () => [],
      render: () => ({ onStart: () => {}, onUpdate: () => {}, onExit: () => {}, onKeyDown: () => false }),
    },
    toEmoji: (code) => (code === "rocket" ? "🚀" : null),
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

function insertText(editor: Editor, text: string) {
  let handled = false

  editor.view.someProp("handleTextInput", (handleTextInput) => {
    if (
      handleTextInput(editor.view, editor.state.selection.from, editor.state.selection.to, text, () => editor.state.tr)
    ) {
      handled = true
      return true
    }
    return false
  })

  return handled
}

function createBlockquote(lines: string[]): JSONContent {
  return {
    type: "doc",
    content: [
      {
        type: "blockquote",
        content: lines.map((line) => ({
          type: "paragraph",
          content: line ? [{ type: "text", text: line }] : undefined,
        })),
      },
    ],
  }
}

function createAdjacentCodeBlocks(lines: string[]): JSONContent {
  return {
    type: "doc",
    content: lines.map((line) => ({
      type: "codeBlock",
      content: line ? [{ type: "text", text: line }] : undefined,
    })),
  }
}

function createAdjacentBlockquotes(lines: string[]): JSONContent {
  return {
    type: "doc",
    content: lines.map((line) => ({
      type: "blockquote",
      content: [
        {
          type: "paragraph",
          content: line ? [{ type: "text", text: line }] : undefined,
        },
      ],
    })),
  }
}

function findTextPosition(editor: Editor, text: string, occurrence = 1): number {
  let remaining = occurrence
  let found: number | null = null

  editor.state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) {
      return true
    }

    const index = node.text.indexOf(text)
    if (index === -1) {
      return true
    }

    remaining -= 1
    if (remaining === 0) {
      found = pos + index
      return false
    }

    return true
  })

  if (found === null) {
    throw new Error(`Could not find text: ${text}`)
  }

  return found
}

function setCursor(editor: Editor, text: string, occurrence = 1) {
  const from = findTextPosition(editor, text, occurrence)
  editor.commands.setTextSelection(from)
}

function selectText(editor: Editor, text: string) {
  const from = findTextPosition(editor, text)
  editor.commands.setTextSelection({ from, to: from + text.length })
}

function selectLines(editor: Editor, startText: string, endText: string) {
  const from = findTextPosition(editor, startText)
  const to = findTextPosition(editor, endText) + endText.length
  editor.commands.setTextSelection({ from, to })
}

function makeBeforeInput(inputType: string = "insertParagraph", data: string | null = null) {
  return {
    inputType,
    data,
    prevented: false,
    preventDefault() {
      this.prevented = true
    },
  }
}

describe("multiline block toggles", () => {
  it("wraps selected paragraphs in a single code block", () => {
    const editor = createTestEditor("line 1\n\nline 2\n\nline 3")

    selectLines(editor, "line 1", "line 3")
    toggleMultilineBlock(editor, "codeBlock")

    expect(editor.state.doc.childCount).toBe(1)
    expect(editor.state.doc.firstChild?.type.name).toBe("codeBlock")
    expect(editor.state.doc.firstChild?.textContent).toBe("line 1\nline 2\nline 3")
    editor.destroy()
  })

  it("wraps selected paragraphs in a single blockquote", () => {
    const editor = createTestEditor("line 1\n\nline 2\n\nline 3")

    selectLines(editor, "line 1", "line 3")
    toggleMultilineBlock(editor, "blockquote")

    const blockquote = editor.state.doc.firstChild

    expect(editor.state.doc.childCount).toBe(1)
    expect(blockquote?.type.name).toBe("blockquote")
    expect(blockquote?.childCount).toBe(3)
    expect(
      Array.from({ length: blockquote?.childCount ?? 0 }, (_, index) => blockquote?.child(index).textContent)
    ).toEqual(["line 1", "line 2", "line 3"])
    editor.destroy()
  })

  it("unwraps only the current code block line when toggled off below the first line", () => {
    const editor = createTestEditor("```\nline 1\nline 2\nline 3\n```")

    setCursor(editor, "line 2")
    toggleMultilineBlock(editor, "codeBlock")

    expect(serializeToMarkdown(editor.getJSON())).toBe("```\nline 1\n```\n\nline 2\n\n```\nline 3\n```")
    editor.destroy()
  })

  it("unwraps the full code block when toggled off from the first line", () => {
    const editor = createTestEditor("```\nline 1\nline 2\nline 3\n```")

    setCursor(editor, "line 1")
    toggleMultilineBlock(editor, "codeBlock")

    expect(serializeToMarkdown(editor.getJSON())).toBe("line 1\n\nline 2\n\nline 3")
    editor.destroy()
  })

  it("unwraps the selected code block lines without removing the rest of the block", () => {
    const editor = createTestEditor("```\nline 1\nline 2\nline 3\n```")

    selectLines(editor, "line 2", "line 3")
    toggleMultilineBlock(editor, "codeBlock")

    expect(serializeToMarkdown(editor.getJSON())).toBe("```\nline 1\n```\n\nline 2\n\nline 3")
    editor.destroy()
  })

  it("unwraps selected adjacent code blocks", () => {
    const editor = createTestEditor(createAdjacentCodeBlocks(["line 1", "line 2", "line 3"]))

    selectLines(editor, "line 1", "line 3")
    toggleMultilineBlock(editor, "codeBlock")

    expect(serializeToMarkdown(editor.getJSON())).toBe("line 1\n\nline 2\n\nline 3")
    editor.destroy()
  })

  it("unwraps only the current blockquote line when toggled off below the first line", () => {
    const editor = createTestEditor(createBlockquote(["line 1", "line 2", "line 3"]))

    setCursor(editor, "line 2")
    toggleMultilineBlock(editor, "blockquote")

    expect(serializeToMarkdown(editor.getJSON())).toBe("> line 1\n\nline 2\n\n> line 3")
    editor.destroy()
  })

  it("unwraps the full blockquote when toggled off from the first line", () => {
    const editor = createTestEditor(createBlockquote(["line 1", "line 2", "line 3"]))

    setCursor(editor, "line 1")
    toggleMultilineBlock(editor, "blockquote")

    expect(serializeToMarkdown(editor.getJSON())).toBe("line 1\n\nline 2\n\nline 3")
    editor.destroy()
  })

  it("unwraps the selected blockquote lines without removing the rest of the quote", () => {
    const editor = createTestEditor(createBlockquote(["line 1", "line 2", "line 3"]))

    selectLines(editor, "line 2", "line 3")
    toggleMultilineBlock(editor, "blockquote")

    expect(serializeToMarkdown(editor.getJSON())).toBe("> line 1\n\nline 2\n\nline 3")
    editor.destroy()
  })

  it("unwraps selected adjacent blockquotes", () => {
    const editor = createTestEditor(createAdjacentBlockquotes(["line 1", "line 2", "line 3"]))

    selectLines(editor, "line 1", "line 3")
    toggleMultilineBlock(editor, "blockquote")

    expect(serializeToMarkdown(editor.getJSON())).toBe("line 1\n\nline 2\n\nline 3")
    editor.destroy()
  })
})

describe("multiline block paste handling", () => {
  it("keeps pasted multiline text inside a code block", () => {
    const editor = createTestEditor("```\nseed\n```")

    selectText(editor, "seed")
    insertPastedText(
      editor,
      "line 1\nline 2",
      () => "user",
      () => null
    )

    expect(serializeToMarkdown(editor.getJSON())).toBe("```\nline 1\nline 2\n```")
    editor.destroy()
  })

  it("keeps pasted multiline text inside a blockquote", () => {
    const editor = createTestEditor(createBlockquote(["seed"]))

    selectText(editor, "seed")
    insertPastedText(
      editor,
      "line 1\nline 2",
      () => "user",
      () => null
    )

    expect(serializeToMarkdown(editor.getJSON())).toBe("> line 1\n> line 2")
    editor.destroy()
  })

  it("inserts a single-line paste inline without splitting the current paragraph", () => {
    const editor = createTestEditor("Hello ")

    editor.commands.setTextSelection(editor.state.doc.content.size)
    insertPastedText(
      editor,
      "World",
      () => "user",
      () => null
    )

    expect(editor.state.doc.childCount).toBe(1)
    expect(editor.state.doc.firstChild?.type.name).toBe("paragraph")
    expect(serializeToMarkdown(editor.getJSON())).toBe("Hello World")
    editor.destroy()
  })

  it("inserts a single-line paste mid-paragraph without splitting it in two", () => {
    const editor = createTestEditor("Hi my  friend")

    setCursor(editor, " friend")
    insertPastedText(
      editor,
      "little",
      () => "user",
      () => null
    )

    expect(editor.state.doc.childCount).toBe(1)
    expect(editor.state.doc.firstChild?.type.name).toBe("paragraph")
    expect(serializeToMarkdown(editor.getJSON())).toBe("Hi my little friend")
    editor.destroy()
  })

  it("preserves active marks when pasting plain text inside a styled span", () => {
    const editor = createTestEditor("**bold** text")

    // Place the cursor in the middle of the bold word ("bol|d")
    setCursor(editor, "d")
    insertPastedText(
      editor,
      "X",
      () => "user",
      () => null
    )

    expect(editor.state.doc.childCount).toBe(1)
    expect(serializeToMarkdown(editor.getJSON())).toBe("**bolXd** text")
    editor.destroy()
  })

  it("reconstructs a sharedMessage block when pasted into an empty editor", () => {
    const editor = createTestEditor("")
    editor.commands.setTextSelection(editor.state.doc.content.size)
    insertPastedText(
      editor,
      "Shared a message from [Ariadne](shared-message:stream_01XYZ/msg_01ABC)",
      () => "user",
      () => null
    )

    expect(editor.getJSON().content?.[0]).toMatchObject({
      type: "sharedMessage",
      attrs: { messageId: "msg_01ABC", streamId: "stream_01XYZ", authorName: "Ariadne" },
    })
    editor.destroy()
  })

  it("reconstructs a GFM table from a markdown paste", () => {
    const editor = createTestEditor("")
    editor.commands.setTextSelection(editor.state.doc.content.size)
    const tableMarkdown = ["| Name | Role |", "| --- | --- |", "| Alice | PM |", "| Bob | Eng |"].join("\n")
    insertPastedText(
      editor,
      tableMarkdown,
      () => "user",
      () => null
    )

    const tableNode = (editor.getJSON().content ?? []).find((b) => b.type === "table")
    expect(tableNode).toBeDefined()
    expect(tableNode?.content).toHaveLength(3)
    expect(serializeToMarkdown(editor.getJSON())).toContain("| Alice | PM |")
    editor.destroy()
  })

  it("round-trips a copied table back through paste", () => {
    // Build a table doc, serialize it (the cut/copy path), then paste it back
    // into a fresh editor. This is the in-app copy/paste scenario: the
    // clipboard carries our own markdown, so the destination must rebuild the
    // exact same structure.
    const tableDoc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableHeader",
                  attrs: { colspan: 1, rowspan: 1, colwidth: null },
                  content: [{ type: "paragraph", content: [{ type: "text", text: "h1" }] }],
                },
                {
                  type: "tableHeader",
                  attrs: { colspan: 1, rowspan: 1, colwidth: null },
                  content: [{ type: "paragraph", content: [{ type: "text", text: "h2" }] }],
                },
              ],
            },
            {
              type: "tableRow",
              content: [
                {
                  type: "tableCell",
                  attrs: { colspan: 1, rowspan: 1, colwidth: null },
                  content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }],
                },
                {
                  type: "tableCell",
                  attrs: { colspan: 1, rowspan: 1, colwidth: null },
                  content: [{ type: "paragraph", content: [{ type: "text", text: "b" }] }],
                },
              ],
            },
          ],
        },
      ],
    }
    const copied = serializeToMarkdown(tableDoc)

    const editor = createTestEditor("")
    editor.commands.setTextSelection(editor.state.doc.content.size)
    insertPastedText(
      editor,
      copied,
      () => "user",
      () => null
    )

    // The re-serialized output must match the original markdown.
    expect(serializeToMarkdown(editor.getJSON())).toBe(copied)
    editor.destroy()
  })

  it("reconstructs a sharedMessage when pasted into a non-empty paragraph", () => {
    const editor = createTestEditor("Hello ")
    editor.commands.setTextSelection(editor.state.doc.content.size)
    insertPastedText(
      editor,
      "Shared a message from [Ariadne](shared-message:stream_01XYZ/msg_01ABC)",
      () => "user",
      () => null
    )

    const sharedNode = (editor.getJSON().content ?? []).find((b) => b.type === "sharedMessage")
    expect(sharedNode).toMatchObject({
      type: "sharedMessage",
      attrs: { messageId: "msg_01ABC", streamId: "stream_01XYZ" },
    })
    editor.destroy()
  })

  it("reconstructs a quoteReply block when pasted into an empty editor", () => {
    const editor = createTestEditor("")
    editor.commands.setTextSelection(editor.state.doc.content.size)
    insertPastedText(
      editor,
      "> Hello world\n>\n> — [Kristoffer](quote:stream_01XYZ/msg_01ABC/usr_01KR/user)",
      () => "user",
      () => null
    )

    expect(editor.getJSON().content?.[0]).toMatchObject({
      type: "quoteReply",
      attrs: { messageId: "msg_01ABC", snippet: "Hello world" },
    })
    editor.destroy()
  })

  it("reconstructs an attachmentReference when pasted into an empty editor", () => {
    const editor = createTestEditor("")
    editor.commands.setTextSelection(editor.state.doc.content.size)
    insertPastedText(
      editor,
      '[Image #1](attachment:attach_123 "threa-attachment:filename=test.png&mimeType=image%2Fpng&sizeBytes=1024")',
      () => "user",
      () => null
    )

    expect(editor.getJSON().content?.[0]).toMatchObject({
      type: "paragraph",
      content: [
        {
          type: "attachmentReference",
          attrs: { id: "attach_123", filename: "test.png", mimeType: "image/png", sizeBytes: 1024 },
        },
      ],
    })
    editor.destroy()
  })

  it("pastes multiline markdown with TypeScript generics, blockquotes, and attachment references", () => {
    const editor = createTestEditor("")
    editor.commands.setTextSelection(editor.state.doc.content.size)

    const handled = insertPastedText(
      editor,
      `Sure, here's the content for your infinite scroller test! :tada:

---

**React component (~25 lines):**

\`\`\`tsx
import { useState, useEffect } from "react"

type User = { id: number; name: string; email: string }

export function UserList() {
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function fetchUsers() {
      try {
        const res = await fetch("https://jsonplaceholder.typicode.com/users")
        if (!res.ok) throw new Error("Failed to fetch")
        const data: User[] = await res.json()
        setUsers(data)
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error")
      } finally {
        setLoading(false)
      }
    }
    fetchUsers()
  }, [])

  if (loading) return <p>Loading...</p>
  if (error) return <p>Error: {error}</p>

  return (
    <ul>
      {users.map((user) => (
        <li key={user.id}>
          <strong>{user.name}</strong> — {user.email}
        </li>
      ))}
    </ul>
  )
}
\`\`\`

---

**Block quote — excerpt from the Wikipedia article on** **[Infinite scroll](https://en.wikipedia.org/wiki/Infinite_scrolling)****:**

> Infinite scrolling is a web-design technique that loads content continuously as the user scrolls down the page, eliminating the need for pagination.
> 
> The technique was popularized by social media platforms such as Facebook and Twitter, where new content is constantly being generated and users benefit from a seamless browsing experience.
> 
> Critics of infinite scroll argue that it removes the user's sense of progress and location within a site, making it difficult to return to a previously viewed item. It can also contribute to excessive time-on-site and compulsive browsing behaviors.
> 
> From an accessibility standpoint, infinite scroll can be problematic for keyboard-only users and screen reader users, as dynamically loaded content may not be announced or reachable without additional ARIA live region support.
> 
> Some designers advocate for a "load more" button as a hybrid approach — preserving the convenience of on-demand loading while giving users explicit control over when new content appears.

---

And here's the image you attached:

[Image #1](attachment:attach_01KRGE6JQYT12J75NXNNNBKXNX "threa-attachment:mimeType=image%2Funknown")

And the repo link you shared: [threahq/threa](https://github.com/threahq/threa) — looks like a TypeScript-heavy monorepo, AI-powered chat with GAM memory. Neat! 

Hope this gives the scroller a good workout. Let me know if you need more variety (e.g. a longer nested list, table, etc.).`,
      () => "user",
      () => null
    )

    expect(handled).toBe(true)
    expect(serializeToMarkdown(editor.getJSON())).toContain("attachment:attach_01KRGE6JQYT12J75NXNNNBKXNX")
    editor.destroy()
  })

  it("keeps multi-line plain-text pastes as separate paragraphs", () => {
    const editor = createTestEditor("prefix ")

    editor.commands.setTextSelection(editor.state.doc.content.size)
    insertPastedText(
      editor,
      "line 1\nline 2",
      () => "user",
      () => null
    )

    expect(serializeToMarkdown(editor.getJSON())).toBe("prefix line 1\n\nline 2")
    editor.destroy()
  })
})

describe("multiline beforeinput enter handling", () => {
  it("exits a code block after a third newline via beforeinput", () => {
    const editor = createTestEditor("```\nconst x = 1\n```")

    editor.commands.setTextSelection(editor.state.doc.content.size - 1)

    const firstEvent = makeBeforeInput("insertParagraph")
    expect(handleBeforeInputNewline(editor, firstEvent)).toBe(true)
    expect(firstEvent.prevented).toBe(true)
    expect(editor.state.doc.firstChild?.type.name).toBe("codeBlock")
    expect(editor.state.doc.firstChild?.textContent).toBe("const x = 1\n")

    const secondEvent = makeBeforeInput("insertParagraph")
    expect(handleBeforeInputNewline(editor, secondEvent)).toBe(true)
    expect(secondEvent.prevented).toBe(true)
    expect(editor.state.doc.firstChild?.type.name).toBe("codeBlock")
    expect(editor.state.doc.firstChild?.textContent).toBe("const x = 1\n\n")
    expect(editor.isActive("codeBlock")).toBe(true)

    const thirdEvent = makeBeforeInput("insertParagraph")
    expect(handleBeforeInputNewline(editor, thirdEvent)).toBe(true)
    expect(thirdEvent.prevented).toBe(true)
    expect(editor.state.doc.firstChild?.type.name).toBe("codeBlock")
    expect(editor.state.doc.firstChild?.textContent).toBe("const x = 1")
    expect(editor.state.doc.lastChild?.type.name).toBe("paragraph")
    expect(editor.isActive("codeBlock")).toBe(false)
    editor.destroy()
  })

  it("exits a blockquote after a third newline via beforeinput", () => {
    const editor = createTestEditor(createBlockquote(["quoted line"]))

    editor.commands.setTextSelection(editor.state.doc.content.size - 1)

    const firstEvent = makeBeforeInput("insertParagraph")
    expect(handleBeforeInputNewline(editor, firstEvent)).toBe(true)
    expect(firstEvent.prevented).toBe(true)
    expect(editor.state.doc.firstChild?.type.name).toBe("blockquote")
    expect(editor.state.doc.firstChild?.childCount).toBe(2)

    const secondEvent = makeBeforeInput("insertParagraph")
    expect(handleBeforeInputNewline(editor, secondEvent)).toBe(true)
    expect(secondEvent.prevented).toBe(true)
    expect(editor.state.doc.firstChild?.type.name).toBe("blockquote")
    expect(editor.state.doc.firstChild?.childCount).toBe(3)
    expect(editor.isActive("blockquote")).toBe(true)

    const thirdEvent = makeBeforeInput("insertParagraph")
    expect(handleBeforeInputNewline(editor, thirdEvent)).toBe(true)
    expect(thirdEvent.prevented).toBe(true)
    expect(editor.state.doc.firstChild?.type.name).toBe("blockquote")
    expect(editor.state.doc.firstChild?.childCount).toBe(2)
    expect(editor.state.doc.lastChild?.type.name).toBe("paragraph")
    expect(editor.isActive("blockquote")).toBe(false)
    editor.destroy()
  })
})

describe("handleBeforeInputKeyboardPaste (Gboard suggestion-bar paste)", () => {
  it("intercepts multi-char insertText containing markdown chars", () => {
    const editor = createTestEditor("")
    editor.commands.setTextSelection(editor.state.doc.content.size)

    const event = makeBeforeInput("insertText", "**bold text**")
    const handled = handleBeforeInputKeyboardPaste(
      editor,
      event,
      () => "user",
      () => null
    )

    expect(handled).toBe(true)
    expect(event.prevented).toBe(true)
    expect(serializeToMarkdown(editor.getJSON())).toBe("**bold text**")
    editor.destroy()
  })

  it("intercepts multi-line insertText", () => {
    const editor = createTestEditor("")
    editor.commands.setTextSelection(editor.state.doc.content.size)

    const event = makeBeforeInput("insertText", "line 1\nline 2")
    const handled = handleBeforeInputKeyboardPaste(
      editor,
      event,
      () => "user",
      () => null
    )

    expect(handled).toBe(true)
    expect(event.prevented).toBe(true)
    expect(serializeToMarkdown(editor.getJSON())).toBe("line 1\n\nline 2")
    editor.destroy()
  })

  it("ignores single-char insertText (normal typing)", () => {
    const editor = createTestEditor("")
    editor.commands.setTextSelection(editor.state.doc.content.size)

    const event = makeBeforeInput("insertText", "x")
    const handled = handleBeforeInputKeyboardPaste(
      editor,
      event,
      () => "user",
      () => null
    )

    expect(handled).toBe(false)
    expect(event.prevented).toBe(false)
    editor.destroy()
  })

  it("ignores multi-word insertText with no markdown chars (word suggestions / swipe typing)", () => {
    const editor = createTestEditor("")
    editor.commands.setTextSelection(editor.state.doc.content.size)

    const event = makeBeforeInput("insertText", "hello world")
    const handled = handleBeforeInputKeyboardPaste(
      editor,
      event,
      () => "user",
      () => null
    )

    expect(handled).toBe(false)
    expect(event.prevented).toBe(false)
    editor.destroy()
  })

  it("ignores insertText shorter than 3 chars even with styling chars", () => {
    const editor = createTestEditor("")
    editor.commands.setTextSelection(editor.state.doc.content.size)

    const event = makeBeforeInput("insertText", "**")
    const handled = handleBeforeInputKeyboardPaste(
      editor,
      event,
      () => "user",
      () => null
    )

    expect(handled).toBe(false)
    expect(event.prevented).toBe(false)
    editor.destroy()
  })

  it("ignores non-insertText input types (e.g. insertCompositionText)", () => {
    const editor = createTestEditor("")
    editor.commands.setTextSelection(editor.state.doc.content.size)

    const event = makeBeforeInput("insertCompositionText", "**bold**")
    const handled = handleBeforeInputKeyboardPaste(
      editor,
      event,
      () => "user",
      () => null
    )

    expect(handled).toBe(false)
    expect(event.prevented).toBe(false)
    editor.destroy()
  })

  it("falls through inside code blocks so plain text flows verbatim", () => {
    const editor = createTestEditor("```\nseed\n```")
    setCursor(editor, "seed")

    const event = makeBeforeInput("insertText", "**bold**")
    const handled = handleBeforeInputKeyboardPaste(
      editor,
      event,
      () => "user",
      () => null
    )

    expect(handled).toBe(false)
    expect(event.prevented).toBe(false)
    editor.destroy()
  })

  it("intercepts emoji shortcode pastes", () => {
    const editor = createTestEditor("")
    editor.commands.setTextSelection(editor.state.doc.content.size)

    const event = makeBeforeInput("insertText", ":rocket: launching")
    const handled = handleBeforeInputKeyboardPaste(
      editor,
      event,
      () => "user",
      (code) => (code === "rocket" ? "🚀" : null)
    )

    expect(handled).toBe(true)
    expect(event.prevented).toBe(true)
    expect(editor.getJSON().content?.[0]?.content?.[0]).toEqual({ type: "text", text: "🚀 launching" })
    expect(serializeToMarkdown(editor.getJSON())).toBe("🚀 launching")
    editor.destroy()
  })

  it("intercepts URL pastes (the colon in ':// matches the styling-char heuristic)", () => {
    const editor = createTestEditor("")
    editor.commands.setTextSelection(editor.state.doc.content.size)

    const event = makeBeforeInput("insertText", "https://example.com")
    const handled = handleBeforeInputKeyboardPaste(
      editor,
      event,
      () => "user",
      () => null
    )

    expect(handled).toBe(true)
    expect(event.prevented).toBe(true)
    editor.destroy()
  })

  it("intercepts mention pastes (`@alice`)", () => {
    const editor = createTestEditor("")
    editor.commands.setTextSelection(editor.state.doc.content.size)

    const event = makeBeforeInput("insertText", "Hey @alice ping")
    const handled = handleBeforeInputKeyboardPaste(
      editor,
      event,
      () => "user",
      () => null
    )

    expect(handled).toBe(true)
    expect(event.prevented).toBe(true)
    const inline = (editor.getJSON().content?.[0]?.content ?? []) as JSONContent[]
    expect(inline.find((n) => n.type === "mention")).toMatchObject({
      type: "mention",
      attrs: { slug: "alice" },
    })
    editor.destroy()
  })

  it("intercepts channel-ref pastes (`#general`)", () => {
    const editor = createTestEditor("")
    editor.commands.setTextSelection(editor.state.doc.content.size)

    const event = makeBeforeInput("insertText", "see #general for context")
    const handled = handleBeforeInputKeyboardPaste(
      editor,
      event,
      () => "user",
      () => null
    )

    expect(handled).toBe(true)
    expect(event.prevented).toBe(true)
    const inline = (editor.getJSON().content?.[0]?.content ?? []) as JSONContent[]
    expect(inline.find((n) => n.type === "channelLink")).toMatchObject({
      type: "channelLink",
      attrs: { slug: "general" },
    })
    editor.destroy()
  })

  it("intercepts pointer URL pastes (sharedMessage)", () => {
    const editor = createTestEditor("")
    editor.commands.setTextSelection(editor.state.doc.content.size)

    const event = makeBeforeInput(
      "insertText",
      "Shared a message from [Ariadne](shared-message:stream_01XYZ/msg_01ABC)"
    )
    const handled = handleBeforeInputKeyboardPaste(
      editor,
      event,
      () => "user",
      () => null
    )

    expect(handled).toBe(true)
    expect(event.prevented).toBe(true)
    expect(editor.getJSON().content?.[0]).toMatchObject({ type: "sharedMessage" })
    editor.destroy()
  })

  it("ignores null data", () => {
    const editor = createTestEditor("")
    editor.commands.setTextSelection(editor.state.doc.content.size)

    const event = makeBeforeInput("insertText", null)
    const handled = handleBeforeInputKeyboardPaste(
      editor,
      event,
      () => "user",
      () => null
    )

    expect(handled).toBe(false)
    expect(event.prevented).toBe(false)
    editor.destroy()
  })
})

describe("handleBeforeInputAtomDelete (Android atom deletion)", () => {
  function emojiDoc(prefix: string, suffix: string): JSONContent {
    const inline: JSONContent[] = []
    if (prefix) inline.push({ type: "text", text: prefix })
    inline.push({ type: "emoji", attrs: { shortcode: "rocket", emoji: "🚀" } })
    if (suffix) inline.push({ type: "text", text: suffix })
    return {
      type: "doc",
      content: [{ type: "paragraph", content: inline }],
    }
  }

  it("deletes the inline atom on deleteContentBackward when caret sits right after it", () => {
    const editor = createTestEditor(emojiDoc("hi ", " end"))
    // Caret at the start of " end" — i.e. immediately after the emoji atom.
    editor.commands.setTextSelection(findTextPosition(editor, " end"))

    const event = makeBeforeInput("deleteContentBackward")
    const handled = handleBeforeInputAtomDelete(editor, event)

    expect(handled).toBe(true)
    expect(event.prevented).toBe(true)
    expect(serializeToMarkdown(editor.getJSON())).toBe("hi  end")
    editor.destroy()
  })

  it("renders emoji atoms with text-like inline layout", () => {
    const editor = createTestEditor(emojiDoc("", ""))
    const emoji = editor.view.dom.querySelector<HTMLElement>('span[data-type="emoji"]')

    expect(emoji?.className).toBe("inline")
    editor.destroy()
  })

  it("converts typed shortcode emoji to editable text instead of a new atom", () => {
    const editor = createTestEditor(":rocket")
    editor.commands.setTextSelection(editor.state.doc.content.size)

    expect(insertText(editor, ":")).toBe(true)
    expect(editor.getJSON().content?.[0]?.content?.[0]).toEqual({ type: "text", text: "🚀" })
    editor.destroy()
  })

  it("deletes the inline atom on deleteContentForward when caret sits right before it", () => {
    const editor = createTestEditor(emojiDoc("hi ", " end"))
    // Caret at end of "hi " — i.e. immediately before the emoji atom.
    editor.commands.setTextSelection(findTextPosition(editor, "hi ") + 3)

    const event = makeBeforeInput("deleteContentForward")
    const handled = handleBeforeInputAtomDelete(editor, event)

    expect(handled).toBe(true)
    expect(event.prevented).toBe(true)
    expect(serializeToMarkdown(editor.getJSON())).toBe("hi  end")
    editor.destroy()
  })

  it("deletes a mention atom on deleteContentBackward", () => {
    const editor = createTestEditor("@alice trailing")
    editor.commands.setTextSelection(findTextPosition(editor, " trailing"))

    const event = makeBeforeInput("deleteContentBackward")
    const handled = handleBeforeInputAtomDelete(editor, event)

    expect(handled).toBe(true)
    expect(event.prevented).toBe(true)
    expect(serializeToMarkdown(editor.getJSON())).toBe(" trailing")
    editor.destroy()
  })

  it("falls through when the adjacent node is plain text", () => {
    const editor = createTestEditor("hello world")
    editor.commands.setTextSelection(findTextPosition(editor, "hello world") + "hello world".length)

    const event = makeBeforeInput("deleteContentBackward")
    const handled = handleBeforeInputAtomDelete(editor, event)

    expect(handled).toBe(false)
    expect(event.prevented).toBe(false)
    editor.destroy()
  })

  it("falls through when the selection is non-empty (range delete)", () => {
    const editor = createTestEditor(emojiDoc("hi ", " end"))
    selectText(editor, "hi")

    const event = makeBeforeInput("deleteContentBackward")
    const handled = handleBeforeInputAtomDelete(editor, event)

    expect(handled).toBe(false)
    expect(event.prevented).toBe(false)
    editor.destroy()
  })

  it("deletes a non-empty selection containing an inline atom", () => {
    const editor = createTestEditor(emojiDoc("hi ", " end"))
    editor.commands.setTextSelection({
      from: findTextPosition(editor, "hi "),
      to: findTextPosition(editor, " end"),
    })

    const event = makeBeforeInput("deleteContentBackward")
    const handled = handleBeforeInputAtomDelete(editor, event)

    expect(handled).toBe(true)
    expect(event.prevented).toBe(true)
    expect(serializeToMarkdown(editor.getJSON())).toBe(" end")
    editor.destroy()
  })

  it("ignores non-delete input types", () => {
    const editor = createTestEditor(emojiDoc("hi ", ""))
    editor.commands.setTextSelection(editor.state.doc.content.size)

    const event = makeBeforeInput("insertText", "x")
    const handled = handleBeforeInputAtomDelete(editor, event)

    expect(handled).toBe(false)
    expect(event.prevented).toBe(false)
    editor.destroy()
  })

  it("falls through when caret is not adjacent to any atom (mid-text)", () => {
    const editor = createTestEditor(emojiDoc("hello ", " trailing"))
    // Caret in middle of "hello " — far from any atom
    editor.commands.setTextSelection(findTextPosition(editor, "hello") + 2)

    const event = makeBeforeInput("deleteContentBackward")
    const handled = handleBeforeInputAtomDelete(editor, event)

    expect(handled).toBe(false)
    expect(event.prevented).toBe(false)
    editor.destroy()
  })

  it("deletes a NodeSelection on an inline atom in one keystroke (Firefox Android)", () => {
    const editor = createTestEditor(emojiDoc("hi ", " end"))
    // Simulate Firefox Android promoting the selection to a NodeSelection on
    // first Backspace. Position is the open-pos of the emoji atom.
    const atomPos = findTextPosition(editor, " end") - 1
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, atomPos)))

    const handled = deleteAdjacentInlineAtom(editor, "backward")

    expect(handled).toBe(true)
    expect(serializeToMarkdown(editor.getJSON())).toBe("hi  end")
    editor.destroy()
  })

  it("keeps the direct keymap fallback inactive while composing", () => {
    const editor = createTestEditor(emojiDoc("hi ", " end"))
    editor.commands.setTextSelection(findTextPosition(editor, " end"))
    ;(editor.view as unknown as { input: { composing: boolean } }).input.composing = true

    const handled = deleteAdjacentInlineAtom(editor, "backward")

    expect(handled).toBe(false)
    expect(serializeToMarkdown(editor.getJSON())).toBe("hi :rocket: end")
    editor.destroy()
  })

  it("deletes the adjacent atom from beforeinput while composing", () => {
    const editor = createTestEditor(emojiDoc("hi ", " end"))
    editor.commands.setTextSelection(findTextPosition(editor, " end"))
    ;(editor.view as unknown as { input: { composing: boolean } }).input.composing = true

    const event = makeBeforeInput("deleteContentBackward")
    const handled = handleBeforeInputAtomDelete(editor, event)

    expect(handled).toBe(true)
    expect(event.prevented).toBe(true)
    expect(serializeToMarkdown(editor.getJSON())).toBe("hi  end")
    editor.destroy()
  })

  it("flushes a pending DOM selection before checking the delete target", () => {
    const editor = createTestEditor(emojiDoc("hi ", " end"))
    editor.commands.setTextSelection(findTextPosition(editor, "hi "))
    const domObserver = (editor.view as unknown as { domObserver: { flush: () => void } }).domObserver
    const originalFlush = domObserver.flush.bind(domObserver)
    let flushed = false

    domObserver.flush = () => {
      flushed = true
      editor.commands.setTextSelection(findTextPosition(editor, " end"))
    }

    const event = makeBeforeInput("deleteContentBackward")
    const handled = handleBeforeInputAtomDelete(editor, event)
    domObserver.flush = originalFlush

    expect(flushed).toBe(true)
    expect(handled).toBe(true)
    expect(event.prevented).toBe(true)
    expect(serializeToMarkdown(editor.getJSON())).toBe("hi  end")
    editor.destroy()
  })

  it("ignores a NodeSelection on a non-atom (defensive)", () => {
    const editor = createTestEditor("plain")
    // No atoms in this doc, so NodeSelection branch shouldn't fire — fall through
    // to the empty-cursor path, which also returns false.
    editor.commands.setTextSelection(0)

    const handled = deleteAdjacentInlineAtom(editor, "backward")

    expect(handled).toBe(false)
    editor.destroy()
  })
})

describe("handleBeforeInputGraphemeDelete (mobile emoji text deletion)", () => {
  it("deletes a text emoji as one grapheme on deleteContentBackward", () => {
    const editor = createTestEditor("hi 🚀 end")
    editor.commands.setTextSelection(findTextPosition(editor, " end"))

    const event = makeBeforeInput("deleteContentBackward")
    const handled = handleBeforeInputGraphemeDelete(editor, event)

    expect(handled).toBe(true)
    expect(event.prevented).toBe(true)
    expect(serializeToMarkdown(editor.getJSON())).toBe("hi  end")
    editor.destroy()
  })

  it("deletes a text emoji as one grapheme on deleteContentForward", () => {
    const editor = createTestEditor("hi 🚀 end")
    editor.commands.setTextSelection(findTextPosition(editor, "🚀"))

    const event = makeBeforeInput("deleteContentForward")
    const handled = handleBeforeInputGraphemeDelete(editor, event)

    expect(handled).toBe(true)
    expect(event.prevented).toBe(true)
    expect(serializeToMarkdown(editor.getJSON())).toBe("hi  end")
    editor.destroy()
  })

  it("deletes only one emoji when two text emoji are adjacent", () => {
    const editor = createTestEditor("🚀🚀")
    editor.commands.setTextSelection(editor.state.doc.content.size)

    const event = makeBeforeInput("deleteContentBackward")
    const handled = handleBeforeInputGraphemeDelete(editor, event)

    expect(handled).toBe(true)
    expect(event.prevented).toBe(true)
    expect(serializeToMarkdown(editor.getJSON())).toBe("🚀")
    editor.destroy()
  })

  it("recovers when the native selection lands inside a surrogate pair", () => {
    const editor = createTestEditor("hi 🚀 end")
    const emojiStart = findTextPosition(editor, "🚀")
    editor.commands.setTextSelection(emojiStart + 1)

    const event = makeBeforeInput("deleteContentBackward")
    const handled = handleBeforeInputGraphemeDelete(editor, event)

    expect(handled).toBe(true)
    expect(event.prevented).toBe(true)
    expect(serializeToMarkdown(editor.getJSON())).toBe("hi  end")
    editor.destroy()
  })

  it("expands a selection that ends inside a surrogate pair", () => {
    const editor = createTestEditor("a🚀b")
    const start = findTextPosition(editor, "a")
    const emojiStart = findTextPosition(editor, "🚀")
    editor.commands.setTextSelection({ from: start, to: emojiStart + 1 })

    const event = makeBeforeInput("deleteContentBackward")
    const handled = handleBeforeInputGraphemeDelete(editor, event)

    expect(handled).toBe(true)
    expect(event.prevented).toBe(true)
    expect(serializeToMarkdown(editor.getJSON())).toBe("b")
    editor.destroy()
  })

  it("deletes a zwj emoji sequence as one grapheme", () => {
    const editor = createTestEditor("hi 👨‍👩‍👧‍👦 end")
    editor.commands.setTextSelection(findTextPosition(editor, " end"))

    const event = makeBeforeInput("deleteContentBackward")
    const handled = handleBeforeInputGraphemeDelete(editor, event)

    expect(handled).toBe(true)
    expect(event.prevented).toBe(true)
    expect(serializeToMarkdown(editor.getJSON())).toBe("hi  end")
    editor.destroy()
  })

  it("falls through for ordinary single-code-unit text", () => {
    const editor = createTestEditor("hello")
    editor.commands.setTextSelection(editor.state.doc.content.size)

    const event = makeBeforeInput("deleteContentBackward")
    const handled = handleBeforeInputGraphemeDelete(editor, event)

    expect(handled).toBe(false)
    expect(event.prevented).toBe(false)
    expect(serializeToMarkdown(editor.getJSON())).toBe("hello")
    editor.destroy()
  })
})

describe("markdown table input rule", () => {
  function pressEnter(editor: Editor) {
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
    let handled = false
    editor.view.someProp("handleKeyDown", (handleKeyDown) => {
      if (handleKeyDown(editor.view, event)) {
        handled = true
        return true
      }
      return false
    })
    return handled
  }

  it("converts header + separator paragraphs into a table when Enter is pressed", () => {
    // Build the doc as raw paragraphs so the input rule (not the markdown
    // parser at editor-construction time) is what produces the table.
    const editor = createTestEditor({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "| name | age |" }] },
        { type: "paragraph", content: [{ type: "text", text: "| --- | --- |" }] },
      ],
    })
    editor.commands.focus("end")

    expect(pressEnter(editor)).toBe(true)

    const tableNode = (editor.getJSON().content ?? []).find((b) => b.type === "table")
    expect(tableNode).toBeDefined()
    expect(tableNode?.content).toHaveLength(1)
    editor.destroy()
  })

  it("converts a header + separator + data row chain into a table on Enter", () => {
    const editor = createTestEditor({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "| name | age |" }] },
        { type: "paragraph", content: [{ type: "text", text: "| --- | --- |" }] },
        { type: "paragraph", content: [{ type: "text", text: "| Kris | 31 |" }] },
      ],
    })
    editor.commands.focus("end")

    expect(pressEnter(editor)).toBe(true)

    const tableNode = (editor.getJSON().content ?? []).find((b) => b.type === "table")
    expect(tableNode).toBeDefined()
    expect(tableNode?.content).toHaveLength(2)
    expect(serializeToMarkdown(editor.getJSON())).toContain("| Kris | 31 |")
    editor.destroy()
  })

  it("leaves a lone paragraph alone when there's no separator above", () => {
    // No separator row means there's nothing to convert — Enter should fall
    // through to the default new-paragraph behavior, not eat the keystroke.
    const editor = createTestEditor({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "| name | age |" }] }],
    })
    editor.commands.focus("end")

    pressEnter(editor)

    const json = editor.getJSON()
    expect((json.content ?? []).some((b) => b.type === "table")).toBe(false)
    editor.destroy()
  })
})
