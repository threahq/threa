import { describe, expect, it } from "vitest"
import { Editor } from "@tiptap/core"
import { GapCursor } from "@tiptap/pm/gapcursor"
import type { ResolvedPos } from "@tiptap/pm/model"
import type { JSONContent } from "@tiptap/react"
import { createEditorExtensions } from "./editor-extensions"
import { serializeToMarkdown } from "./editor-markdown"

function isValidGapCursorPosition($pos: ResolvedPos): boolean {
  const gapCursor = GapCursor as typeof GapCursor & {
    valid?: (position: ResolvedPos) => boolean
  }

  return gapCursor.valid?.($pos) ?? false
}

function createQuoteReplyNode(): JSONContent {
  return {
    type: "quoteReply",
    attrs: {
      messageId: "msg_123",
      streamId: "stream_123",
      authorName: "Ariadne",
      authorId: "user_123",
      actorType: "user",
      snippet: "The vibes are immaculate",
      version: null,
      range: null,
    },
  }
}

function createQuoteReplyEditor(content: JSONContent = { type: "doc", content: [createQuoteReplyNode()] }) {
  const element = document.createElement("div")
  document.body.append(element)

  const editor = new Editor({
    element,
    extensions: createEditorExtensions({ placeholder: "Type a message..." }),
    content,
  })

  editor.view.hasFocus = () => true

  editor.on("destroy", () => {
    element.remove()
  })

  return editor
}

function setGapCursor(editor: Editor, pos: number) {
  const $pos = editor.state.doc.resolve(pos)

  expect(isValidGapCursorPosition($pos)).toBe(true)
  editor.view.dispatch(editor.state.tr.setSelection(new GapCursor($pos)))
}

function pressKey(editor: Editor, key: string, options: Partial<KeyboardEventInit> = {}) {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...options,
  })
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

function clickQuote(editor: Editor, clientX: number) {
  const quoteNode = editor.state.doc.firstChild
  const quoteElement = editor.view.dom.querySelector('[data-type="quote-reply"]') as HTMLElement | null

  expect(quoteNode).not.toBeNull()
  expect(quoteElement).not.toBeNull()

  Object.defineProperty(quoteElement!, "getBoundingClientRect", {
    configurable: true,
    value: () =>
      ({
        left: 0,
        right: 100,
        width: 100,
        top: 0,
        bottom: 40,
        height: 40,
        x: 0,
        y: 0,
        toJSON() {
          return this
        },
      }) satisfies DOMRect,
  })

  const event = new MouseEvent("click", {
    clientX,
    bubbles: true,
    cancelable: true,
    button: 0,
  })
  Object.defineProperty(event, "target", {
    configurable: true,
    value: quoteElement,
  })

  let handled = false

  editor.view.someProp("handleClickOn", (handleClickOn) => {
    if (handleClickOn(editor.view, 0, quoteNode!, 0, event, true)) {
      handled = true
      return true
    }
    return false
  })

  return handled
}

describe("quote reply gap cursor", () => {
  const quoteMarkdown = serializeToMarkdown({ type: "doc", content: [createQuoteReplyNode()] })

  it("inserts typed text into a new paragraph before a lone quote reply", () => {
    const editor = createQuoteReplyEditor()

    setGapCursor(editor, 0)

    expect(insertText(editor, "Before")).toBe(true)
    expect(serializeToMarkdown(editor.getJSON())).toBe(`Before\n\n${quoteMarkdown}`)

    editor.destroy()
  })

  it("inserts typed text into a new paragraph after a lone quote reply", () => {
    const editor = createQuoteReplyEditor()

    setGapCursor(editor, editor.state.doc.content.size)

    expect(insertText(editor, "After")).toBe(true)
    expect(serializeToMarkdown(editor.getJSON())).toBe(`${quoteMarkdown}\n\nAfter`)

    editor.destroy()
  })

  it("adds exactly one paragraph before a lone quote reply on Enter", () => {
    const editor = createQuoteReplyEditor()

    setGapCursor(editor, 0)

    expect(pressKey(editor, "Enter")).toBe(true)
    expect(editor.getJSON()).toEqual({
      type: "doc",
      content: [{ type: "paragraph" }, createQuoteReplyNode()],
    })

    editor.destroy()
  })

  it("adds exactly one paragraph after a lone quote reply on Enter", () => {
    const editor = createQuoteReplyEditor()

    setGapCursor(editor, editor.state.doc.content.size)

    expect(pressKey(editor, "Enter")).toBe(true)
    expect(editor.getJSON()).toEqual({
      type: "doc",
      content: [createQuoteReplyNode(), { type: "paragraph" }],
    })

    editor.destroy()
  })

  it("moves from the after-quote gap cursor to the before-quote gap cursor with ArrowLeft", () => {
    const editor = createQuoteReplyEditor()

    setGapCursor(editor, editor.state.doc.content.size)

    expect(pressKey(editor, "ArrowLeft")).toBe(true)
    expect(editor.state.selection instanceof GapCursor).toBe(true)
    expect(editor.state.selection.from).toBe(0)

    expect(insertText(editor, "Before")).toBe(true)
    expect(serializeToMarkdown(editor.getJSON())).toBe(`Before\n\n${quoteMarkdown}`)

    editor.destroy()
  })

  it("moves from the before-quote gap cursor to the after-quote gap cursor with ArrowRight", () => {
    const editor = createQuoteReplyEditor()

    setGapCursor(editor, 0)

    expect(pressKey(editor, "ArrowRight")).toBe(true)
    expect(editor.state.selection instanceof GapCursor).toBe(true)
    expect(editor.state.selection.from).toBe(editor.state.doc.content.size)

    expect(insertText(editor, "After")).toBe(true)
    expect(serializeToMarkdown(editor.getJSON())).toBe(`${quoteMarkdown}\n\nAfter`)

    editor.destroy()
  })

  it("tapping the left half of a quote reply moves the cursor before the quote", () => {
    const editor = createQuoteReplyEditor()

    expect(clickQuote(editor, 10)).toBe(true)
    expect(editor.state.selection instanceof GapCursor).toBe(true)
    expect(editor.state.selection.from).toBe(0)

    expect(insertText(editor, "Before")).toBe(true)
    expect(serializeToMarkdown(editor.getJSON())).toBe(`Before\n\n${quoteMarkdown}`)

    editor.destroy()
  })

  it("tapping the right half of a quote reply moves the cursor after the quote", () => {
    const editor = createQuoteReplyEditor()

    expect(clickQuote(editor, 90)).toBe(true)
    expect(editor.state.selection instanceof GapCursor).toBe(true)
    expect(editor.state.selection.from).toBe(editor.state.doc.content.size)

    expect(insertText(editor, "After")).toBe(true)
    expect(serializeToMarkdown(editor.getJSON())).toBe(`${quoteMarkdown}\n\nAfter`)

    editor.destroy()
  })

  it("marks the before-quote gap cursor position in the DOM", () => {
    const editor = createQuoteReplyEditor()

    setGapCursor(editor, 0)

    const gapCursor = editor.view.dom.querySelector(".ProseMirror-gapcursor")

    expect(gapCursor).not.toBeNull()
    expect(gapCursor?.classList.contains("before-quote")).toBe(true)
    expect(editor.view.dom.classList.contains("has-after-quote-gapcursor")).toBe(false)

    editor.destroy()
  })

  it("marks the after-quote gap cursor position in the DOM", () => {
    const editor = createQuoteReplyEditor()

    setGapCursor(editor, editor.state.doc.content.size)

    const gapCursor = editor.view.dom.querySelector(".ProseMirror-gapcursor")

    expect(gapCursor).not.toBeNull()
    expect(gapCursor?.classList.contains("after-quote")).toBe(true)
    expect(editor.view.dom.classList.contains("has-after-quote-gapcursor")).toBe(true)

    editor.destroy()
  })

  it("round-trips the pin through the HTML clipboard so a copied quote stays pinned", () => {
    const pinned: JSONContent = {
      type: "quoteReply",
      attrs: { ...createQuoteReplyNode().attrs, version: 7, range: { from: 4, to: 19 } },
    }
    const source = createQuoteReplyEditor({ type: "doc", content: [pinned] })
    const html = source.getHTML()
    source.destroy()

    const pasted = createQuoteReplyEditor(html as unknown as JSONContent)
    const [node] = pasted.getJSON().content ?? []

    expect(node?.attrs).toMatchObject({ version: 7, range: { from: 4, to: 19 } })
    pasted.destroy()
  })
})
