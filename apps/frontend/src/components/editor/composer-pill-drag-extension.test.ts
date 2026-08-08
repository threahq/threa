import { afterEach, describe, expect, it, vi } from "vitest"
import { fireEvent } from "@testing-library/react"
import { Editor } from "@tiptap/core"
import type { JSONContent } from "@threa/types"
import { createEditorExtensions } from "./editor-extensions"
import {
  COMPOSER_PILL_NODE_NAMES,
  composerPillDropPoint,
  createComposerPillMoveTransaction,
  isComposerPillNode,
} from "./composer-pill-drag-extension"

const openEditors: Editor[] = []

afterEach(() => {
  while (openEditors.length > 0) openEditors.pop()?.destroy()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function pill(type: "mention" | "channelLink" | "slashCommand"): JSONContent {
  if (type === "mention") return { type, attrs: { id: "usr_1", slug: "alice", mentionType: "user" } }
  if (type === "channelLink") return { type, attrs: { id: "stream_1", slug: "design" } }
  return { type, attrs: { name: "invite", clientActionId: null } }
}

function createPillEditor(content: JSONContent[] = [pill("mention"), pill("channelLink"), pill("slashCommand")]) {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: createEditorExtensions({ placeholder: "Type a message..." }),
    content: { type: "doc", content: [{ type: "paragraph", content }] },
  })
  openEditors.push(editor)
  return editor
}

function nodePos(editor: Editor, type: string): number {
  let result = -1
  editor.state.doc.descendants((node, pos) => {
    if (result === -1 && node.type.name === type) result = pos
  })
  if (result === -1) throw new Error(`${type} not found`)
  return result
}

function childTypes(editor: Editor): string[] {
  return editor.state.doc.firstChild?.content.content.map((node) => node.type.name) ?? []
}

function touch(identifier: number, clientX: number, clientY: number): Touch {
  return { identifier, clientX, clientY } as Touch
}

describe("composer pill moves", () => {
  it("covers every inline composer chip while leaving emoji text atoms out", () => {
    const editor = createPillEditor()

    expect(COMPOSER_PILL_NODE_NAMES).toEqual([
      "mention",
      "channelLink",
      "slashCommand",
      "attachmentReference",
      "memoEmbed",
      "inAppLink",
      "giphyEmbed",
    ])
    expect(isComposerPillNode(editor.state.schema.nodes.mention.create())).toBe(true)
    expect(isComposerPillNode(editor.state.schema.nodes.emoji.create())).toBe(false)
  })

  it("builds one transaction that leaves the document unchanged until dispatch", () => {
    const editor = createPillEditor()
    const sourcePos = nodePos(editor, "mention")
    const dropPos = nodePos(editor, "slashCommand") + 1
    const tr = createComposerPillMoveTransaction(editor.state, sourcePos, dropPos)

    expect(childTypes(editor)).toEqual(["mention", "channelLink", "slashCommand"])
    expect(tr).not.toBeNull()

    editor.view.dispatch(tr!)
    expect(childTypes(editor)).toEqual(["channelLink", "slashCommand", "mention"])

    editor.commands.undo()
    expect(childTypes(editor)).toEqual(["mention", "channelLink", "slashCommand"])
  })

  it("can insert the pill at a text caret, not only between other atoms", () => {
    const editor = createPillEditor([pill("mention"), { type: "text", text: "hello" }])
    const tr = createComposerPillMoveTransaction(editor.state, nodePos(editor, "mention"), 5)

    expect(tr).not.toBeNull()
    editor.view.dispatch(tr!)
    expect(editor.getJSON().content?.[0]?.content).toEqual([
      { type: "text", text: "hel" },
      pill("mention"),
      { type: "text", text: "lo" },
    ])
  })

  it("treats either edge of the source pill as a no-op", () => {
    const editor = createPillEditor()
    const sourcePos = nodePos(editor, "mention")

    expect(createComposerPillMoveTransaction(editor.state, sourcePos, sourcePos)).toBeNull()
    expect(createComposerPillMoveTransaction(editor.state, sourcePos, sourcePos + 1)).toBeNull()
  })

  it("does not offer an inline pill cursor inside a code block", () => {
    const editor = new Editor({
      element: document.createElement("div"),
      extensions: createEditorExtensions({ placeholder: "" }),
      content: {
        type: "doc",
        content: [
          { type: "paragraph", content: [pill("mention")] },
          { type: "codeBlock", attrs: { language: "plaintext" }, content: [{ type: "text", text: "code" }] },
        ],
      },
    })
    openEditors.push(editor)
    const source = editor.state.doc.nodeAt(nodePos(editor, "mention"))!
    const codePos = nodePos(editor, "codeBlock") + 1

    expect(composerPillDropPoint(editor.state.doc, codePos, source)).toBeNull()
  })
})

describe("composer pill drag gestures", () => {
  it("shows only source state and an insertion cursor while a mouse drag is in flight", () => {
    const editor = createPillEditor()
    const source = editor.view.dom.querySelector<HTMLElement>('[data-type="mention"]')!
    const dropPos = nodePos(editor, "slashCommand") + 1
    vi.spyOn(editor.view, "posAtCoords").mockReturnValue({ pos: dropPos, inside: -1 })

    fireEvent.mouseDown(source, { button: 0, clientX: 10, clientY: 10 })
    fireEvent.mouseMove(document, { buttons: 1, clientX: 18, clientY: 10 })

    expect(childTypes(editor)).toEqual(["mention", "channelLink", "slashCommand"])
    expect(editor.view.dom.querySelector(".composer-pill-dragging")).not.toBeNull()
    expect(editor.view.dom.querySelector(".composer-pill-drop-cursor")).not.toBeNull()

    fireEvent.mouseUp(document, { button: 0, clientX: 18, clientY: 10 })

    expect(childTypes(editor)).toEqual(["channelLink", "slashCommand", "mention"])
    expect(editor.view.dom.querySelector(".composer-pill-drop-cursor")).toBeNull()
  })

  it("drags attachment React node views through the same path", () => {
    const editor = createPillEditor([
      {
        type: "attachmentReference",
        attrs: {
          id: "att_1",
          filename: "image.png",
          mimeType: "image/png",
          sizeBytes: 42,
          status: "uploaded",
          imageIndex: 1,
          error: null,
        },
      },
      pill("mention"),
    ])
    const source = editor.view.dom.querySelector<HTMLElement>('[data-type="attachment-reference"]')!
    vi.spyOn(editor.view, "posAtCoords").mockReturnValue({ pos: nodePos(editor, "mention") + 1, inside: -1 })

    fireEvent.mouseDown(source, { button: 0, clientX: 10, clientY: 10 })
    fireEvent.mouseMove(document, { buttons: 1, clientX: 18, clientY: 10 })

    expect(source).toHaveClass("composer-pill-dragging")
    fireEvent.keyDown(document, { key: "Escape" })
    expect(editor.view.dom.querySelector(".composer-pill-dragging")).toBeNull()
  })

  it("requires a stationary long press before touch dragging, then commits only on release", () => {
    vi.useFakeTimers()
    const editor = createPillEditor()
    const source = editor.view.dom.querySelector<HTMLElement>('[data-type="mention"]')!
    const dropPos = nodePos(editor, "slashCommand") + 1
    vi.spyOn(editor.view, "posAtCoords").mockReturnValue({ pos: dropPos, inside: -1 })

    fireEvent.touchStart(source, { touches: [touch(7, 10, 10)] })
    vi.advanceTimersByTime(499)
    expect(editor.view.dom.querySelector(".composer-pill-dragging")).toBeNull()

    vi.advanceTimersByTime(1)
    expect(editor.view.dom.querySelector(".composer-pill-dragging")).not.toBeNull()

    fireEvent.touchMove(document, { touches: [touch(7, 20, 10)] })
    expect(childTypes(editor)).toEqual(["mention", "channelLink", "slashCommand"])

    fireEvent.touchEnd(document, { touches: [], changedTouches: [touch(7, 20, 10)] })
    expect(childTypes(editor)).toEqual(["channelLink", "slashCommand", "mention"])
  })

  it("cancels an active drag when a second finger lands outside the editor", () => {
    vi.useFakeTimers()
    const editor = createPillEditor()
    const source = editor.view.dom.querySelector<HTMLElement>('[data-type="mention"]')!

    fireEvent.touchStart(source, { touches: [touch(3, 10, 10)] })
    vi.advanceTimersByTime(500)
    expect(editor.view.dom.querySelector(".composer-pill-dragging")).not.toBeNull()

    fireEvent.touchStart(document.body, { touches: [touch(3, 10, 10), touch(4, 50, 50)] })
    fireEvent.touchEnd(document, { touches: [touch(4, 50, 50)], changedTouches: [touch(3, 10, 10)] })

    expect(childTypes(editor)).toEqual(["mention", "channelLink", "slashCommand"])
    expect(editor.view.dom.querySelector(".composer-pill-dragging")).toBeNull()
  })

  it("leaves touch scrolling alone when the finger moves before the long-press threshold", () => {
    vi.useFakeTimers()
    const editor = createPillEditor()
    const source = editor.view.dom.querySelector<HTMLElement>('[data-type="mention"]')!

    fireEvent.touchStart(source, { touches: [touch(3, 10, 10)] })
    fireEvent.touchMove(document, { touches: [touch(3, 10, 21)] })
    vi.advanceTimersByTime(500)

    expect(childTypes(editor)).toEqual(["mention", "channelLink", "slashCommand"])
    expect(editor.view.dom.querySelector(".composer-pill-dragging")).toBeNull()
  })
})
