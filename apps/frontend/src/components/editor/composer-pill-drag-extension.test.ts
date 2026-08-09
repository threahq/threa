import { afterEach, describe, expect, it, vi } from "vitest"
import { fireEvent } from "@testing-library/react"
import { Editor } from "@tiptap/core"
import { NodeSelection } from "@tiptap/pm/state"
import type { JSONContent } from "@threa/types"
import { serializeClipboardSlice } from "./clipboard-copy"
import { createEditorExtensions } from "./editor-extensions"
import {
  COMPOSER_PILL_NODE_NAMES,
  composerPillDropPoint,
  createComposerPillMoveTransaction,
  isComposerPillNode,
} from "./composer-pill-drag-extension"

const openEditors: Editor[] = []
let originalVibrateDescriptor: PropertyDescriptor | undefined
let vibrateMocked = false

afterEach(() => {
  while (openEditors.length > 0) {
    const editor = openEditors.pop()!
    const element = editor.view.dom.parentElement
    editor.destroy()
    element?.remove()
  }
  if (vibrateMocked) {
    if (originalVibrateDescriptor) {
      Object.defineProperty(window.navigator, "vibrate", originalVibrateDescriptor)
    } else {
      delete (window.navigator as unknown as { vibrate?: Navigator["vibrate"] }).vibrate
    }
    originalVibrateDescriptor = undefined
    vibrateMocked = false
  }
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function pill(type: "mention" | "channelLink" | "slashCommand"): JSONContent {
  if (type === "mention") return { type, attrs: { id: "usr_1", slug: "alice", mentionType: "user" } }
  if (type === "channelLink") return { type, attrs: { id: "stream_1", slug: "design" } }
  return { type, attrs: { name: "invite", clientActionId: null } }
}

function createPillEditor(content: JSONContent[] = [pill("mention"), pill("channelLink"), pill("slashCommand")]) {
  const element = document.createElement("div")
  document.body.appendChild(element)
  const editor = new Editor({
    element,
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

function tapPill(source: HTMLElement, identifier = 1, clientX = 10, clientY = 10) {
  fireEvent.touchStart(source, { touches: [touch(identifier, clientX, clientY)] })
  fireEvent.touchEnd(document, {
    touches: [],
    changedTouches: [touch(identifier, clientX, clientY)],
  })
}

function mockVibrate() {
  originalVibrateDescriptor = Object.getOwnPropertyDescriptor(window.navigator, "vibrate")
  vibrateMocked = true
  const vibrate = vi.fn((_pattern: number | number[]) => true)
  Object.defineProperty(window.navigator, "vibrate", { configurable: true, value: vibrate })
  return vibrate
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
    expect(COMPOSER_PILL_NODE_NAMES.map((name) => editor.state.schema.nodes[name].spec.selectable)).toEqual(
      COMPOSER_PILL_NODE_NAMES.map(() => true)
    )
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

  it("snaps a text drop to whitespace instead of splitting a word", () => {
    const editor = createPillEditor([pill("mention"), { type: "text", text: "hello world" }])
    const sourcePos = nodePos(editor, "mention")
    const source = editor.state.doc.nodeAt(sourcePos)!

    expect(composerPillDropPoint(editor.state.doc, 5, source)).toBe(7)
    const tr = createComposerPillMoveTransaction(editor.state, sourcePos, 5)

    expect(tr).not.toBeNull()
    editor.view.dispatch(tr!)
    expect(editor.getJSON().content?.[0]?.content).toEqual([
      { type: "text", text: "hello" },
      pill("mention"),
      { type: "text", text: " world" },
    ])
  })

  it("does not treat a text mark boundary inside a word as a drop slot", () => {
    const editor = createPillEditor([
      pill("mention"),
      { type: "text", text: "hel", marks: [{ type: "bold" }] },
      { type: "text", text: "lo world" },
    ])
    const source = editor.state.doc.nodeAt(nodePos(editor, "mention"))!

    expect(composerPillDropPoint(editor.state.doc, 5, source)).toBe(7)
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
    expect(document.querySelector(".composer-pill-touch-guide")).toBeNull()

    fireEvent.mouseUp(source, { button: 0, clientX: 18, clientY: 10 })

    expect(childTypes(editor)).toEqual(["channelLink", "slashCommand", "mention"])
    expect(editor.state.selection).not.toBeInstanceOf(NodeSelection)
    expect(editor.state.selection.empty).toBe(true)
    expect(editor.view.dom.querySelector(".composer-pill-drop-cursor")).toBeNull()
  })

  it("allows another mouse press after a drag while suppressing its trailing click", () => {
    const editor = createPillEditor()
    const source = editor.view.dom.querySelector<HTMLElement>('[data-type="mention"]')!
    const dropPos = nodePos(editor, "slashCommand") + 1
    vi.spyOn(editor.view, "posAtCoords").mockReturnValue({ pos: dropPos, inside: -1 })

    fireEvent.mouseDown(source, { button: 0, clientX: 10, clientY: 10 })
    fireEvent.mouseMove(document, { buttons: 1, clientX: 18, clientY: 10 })
    fireEvent.mouseUp(source, { button: 0, clientX: 18, clientY: 10 })

    const movedSource = editor.view.dom.querySelector<HTMLElement>('[data-type="mention"]')!
    const followupMouseDown = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 18,
      clientY: 10,
    })
    movedSource.dispatchEvent(followupMouseDown)
    expect(followupMouseDown.defaultPrevented).toBe(false)
    fireEvent.mouseMove(document, { buttons: 1, clientX: 26, clientY: 10 })
    fireEvent.mouseUp(movedSource, { button: 0, clientX: 26, clientY: 10 })

    const trailingClick = new MouseEvent("click", { bubbles: true, cancelable: true })
    editor.view.dom.querySelector<HTMLElement>('[data-type="mention"]')!.dispatchEvent(trailingClick)
    expect(trailingClick.defaultPrevented).toBe(true)
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

  it("selects and serializes a pill on a touch tap", () => {
    const editor = createPillEditor()
    const source = editor.view.dom.querySelector<HTMLElement>('[data-type="mention"]')!

    tapPill(source, 7)

    expect(editor.state.selection).toBeInstanceOf(NodeSelection)
    expect(editor.state.selection.from).toBe(nodePos(editor, "mention"))
    expect(source).toHaveClass("ProseMirror-selectednode")
    expect(serializeClipboardSlice(editor.state.selection.content(), editor.view)).toBe("[@alice](user:usr_1)")
  })

  it("leaves a stationary touch hold to the native selection and copy menu", () => {
    vi.useFakeTimers()
    const editor = createPillEditor()
    const source = editor.view.dom.querySelector<HTMLElement>('[data-type="mention"]')!

    fireEvent.touchStart(source, { touches: [touch(7, 10, 10)] })
    vi.advanceTimersByTime(500)

    expect(editor.view.dom.querySelector(".composer-pill-dragging")).toBeNull()
    expect(document.querySelector(".composer-pill-touch-guide")).toBeNull()

    const contextMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true })
    source.dispatchEvent(contextMenu)
    expect(contextMenu.defaultPrevented).toBe(false)

    fireEvent.touchEnd(document, { touches: [], changedTouches: [touch(7, 10, 10)] })
    expect(editor.state.selection).not.toBeInstanceOf(NodeSelection)
    expect(editor.view.dom.querySelector(".composer-pill-dragging")).toBeNull()
  })

  it("does not replace native selection when a held touch ends without a contextmenu event", () => {
    vi.useFakeTimers()
    const editor = createPillEditor()
    const source = editor.view.dom.querySelector<HTMLElement>('[data-type="mention"]')!

    fireEvent.touchStart(source, { touches: [touch(7, 10, 10)] })
    vi.advanceTimersByTime(1_302)
    fireEvent.touchEnd(document, { touches: [], changedTouches: [touch(7, 10, 10)] })

    const compatibilityMouseDown = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 10,
      clientY: 10,
    })
    source.dispatchEvent(compatibilityMouseDown)
    fireEvent.mouseUp(source, { button: 0, clientX: 10, clientY: 10 })
    fireEvent.click(source)

    expect(compatibilityMouseDown.defaultPrevented).toBe(true)
    expect(editor.state.selection).not.toBeInstanceOf(NodeSelection)
    expect(source).not.toHaveClass("ProseMirror-selectednode")
  })

  it("leaves a selected pill's stationary hold to the native copy menu", () => {
    vi.useFakeTimers()
    const editor = createPillEditor()
    const source = editor.view.dom.querySelector<HTMLElement>('[data-type="mention"]')!

    tapPill(source)
    fireEvent.touchStart(source, { touches: [touch(7, 10, 10)] })
    vi.advanceTimersByTime(500)

    const contextMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true })
    source.dispatchEvent(contextMenu)
    expect(contextMenu.defaultPrevented).toBe(false)

    fireEvent.touchEnd(document, { touches: [], changedTouches: [touch(7, 10, 10)] })
    expect(editor.state.selection).toBeInstanceOf(NodeSelection)
    expect(editor.view.dom.querySelector(".composer-pill-dragging")).toBeNull()
  })

  it("drags an unselected pill after a hold starts moving", () => {
    vi.useFakeTimers()
    const editor = createPillEditor()
    const source = editor.view.dom.querySelector<HTMLElement>('[data-type="mention"]')!
    const dropPos = nodePos(editor, "slashCommand") + 1
    vi.spyOn(editor.view, "posAtCoords").mockReturnValue({ pos: dropPos, inside: -1 })

    fireEvent.touchStart(source, { touches: [touch(7, 10, 10)] })
    vi.advanceTimersByTime(499)
    fireEvent.touchMove(document, { touches: [touch(7, 10, 10)] })
    expect(editor.view.dom.querySelector(".composer-pill-dragging")).toBeNull()

    vi.advanceTimersByTime(1)
    const contextMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true })
    source.dispatchEvent(contextMenu)
    expect(contextMenu.defaultPrevented).toBe(false)

    fireEvent.touchMove(document, { touches: [touch(7, 21, 10)] })
    expect(editor.view.dom.querySelector(".composer-pill-dragging")).not.toBeNull()

    fireEvent.touchEnd(document, { touches: [], changedTouches: [touch(7, 21, 10)] })
    expect(childTypes(editor)).toEqual(["channelLink", "slashCommand", "mention"])
  })

  it("drags an already-selected pill before the native hold takes over", () => {
    vi.useFakeTimers()
    const vibrate = mockVibrate()
    const editor = createPillEditor()
    const source = editor.view.dom.querySelector<HTMLElement>('[data-type="mention"]')!
    const dropPos = nodePos(editor, "slashCommand") + 1
    vi.spyOn(editor.view, "posAtCoords").mockReturnValue({ pos: dropPos, inside: -1 })

    tapPill(source)
    fireEvent.touchStart(source, { touches: [touch(7, 10, 10)] })
    fireEvent.touchMove(document, { touches: [touch(7, 21, 10)] })

    expect(editor.view.dom.querySelector(".composer-pill-dragging")).not.toBeNull()
    expect(childTypes(editor)).toEqual(["mention", "channelLink", "slashCommand"])
    expect(document.querySelector(".composer-pill-touch-guide")).toHaveTextContent("/invite")

    const contextMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true })
    source.dispatchEvent(contextMenu)
    expect(contextMenu.defaultPrevented).toBe(true)

    fireEvent.touchEnd(document, { touches: [], changedTouches: [touch(7, 21, 10)] })
    expect(childTypes(editor)).toEqual(["channelLink", "slashCommand", "mention"])
    expect(document.querySelector(".composer-pill-touch-guide")).toBeNull()
    expect(vibrate.mock.calls.map(([pattern]) => pattern)).toEqual([10, 10, [10, 20, 10]])
  })

  it("cancels touch drag when the pill loses selection before movement", () => {
    const editor = createPillEditor()
    const source = editor.view.dom.querySelector<HTMLElement>('[data-type="mention"]')!

    tapPill(source)
    fireEvent.touchStart(source, { touches: [touch(7, 10, 10)] })
    editor.commands.setTextSelection(nodePos(editor, "channelLink"))
    fireEvent.touchMove(document, { touches: [touch(7, 21, 10)] })

    expect(childTypes(editor)).toEqual(["mention", "channelLink", "slashCommand"])
    expect(editor.view.dom.querySelector(".composer-pill-dragging")).toBeNull()
    expect(document.querySelector(".composer-pill-touch-guide")).toBeNull()
  })

  it("shows words across formatting-isolated whitespace in the touch guide", () => {
    vi.useFakeTimers()
    const editor = createPillEditor([
      pill("mention"),
      { type: "text", text: "hello", marks: [{ type: "bold" }] },
      { type: "text", text: " ", marks: [{ type: "italic" }] },
      { type: "text", text: "world" },
    ])
    const source = editor.view.dom.querySelector<HTMLElement>('[data-type="mention"]')!
    vi.spyOn(editor.view, "posAtCoords").mockReturnValue({ pos: 7, inside: -1 })

    tapPill(source)
    fireEvent.touchStart(source, { touches: [touch(2, 10, 100)] })
    fireEvent.touchMove(document, { touches: [touch(2, 21, 100)] })

    const context = Array.from(document.querySelectorAll(".composer-pill-touch-guide__context"))
    expect(context.map((element) => element.textContent)).toEqual(["hello", "world"])

    fireEvent.touchCancel(document)
    expect(document.querySelector(".composer-pill-touch-guide")).toBeNull()
  })

  it("refreshes touch-guide context when an inline node updates during the drag", () => {
    vi.useFakeTimers()
    const editor = createPillEditor([
      pill("mention"),
      { type: "text", text: "hello " },
      {
        type: "attachmentReference",
        attrs: {
          id: "att_1",
          filename: "old.txt",
          mimeType: "text/plain",
          sizeBytes: 42,
          status: "uploaded",
          imageIndex: null,
          error: null,
        },
      },
    ])
    const source = editor.view.dom.querySelector<HTMLElement>('[data-type="mention"]')!
    const attachmentPos = nodePos(editor, "attachmentReference")
    vi.spyOn(editor.view, "posAtCoords").mockReturnValue({ pos: attachmentPos, inside: -1 })

    tapPill(source)
    fireEvent.touchStart(source, { touches: [touch(5, 10, 100)] })
    fireEvent.touchMove(document, { touches: [touch(5, 21, 100)] })
    expect(document.querySelector(".composer-pill-touch-guide")).toHaveTextContent("old.txt")

    const attachment = editor.state.doc.nodeAt(attachmentPos)!
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(attachmentPos, undefined, { ...attachment.attrs, filename: "new.txt" })
    )
    expect(document.querySelector(".composer-pill-touch-guide")).toHaveTextContent("new.txt")

    fireEvent.touchCancel(document)
  })

  it("cancels an active drag when a second finger lands outside the editor", () => {
    vi.useFakeTimers()
    const editor = createPillEditor()
    const source = editor.view.dom.querySelector<HTMLElement>('[data-type="mention"]')!

    tapPill(source)
    vi.advanceTimersByTime(401)
    fireEvent.touchStart(source, { touches: [touch(3, 10, 10)] })
    fireEvent.touchMove(document, { touches: [touch(3, 21, 10)] })
    expect(editor.view.dom.querySelector(".composer-pill-dragging")).not.toBeNull()

    fireEvent.touchStart(document.body, { touches: [touch(3, 21, 10), touch(4, 50, 50)] })
    vi.advanceTimersByTime(401)
    fireEvent.touchEnd(document, { touches: [touch(4, 50, 50)], changedTouches: [touch(3, 10, 10)] })

    const compatibilityMouseDown = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 21,
      clientY: 10,
    })
    source.dispatchEvent(compatibilityMouseDown)

    expect(childTypes(editor)).toEqual(["mention", "channelLink", "slashCommand"])
    expect(compatibilityMouseDown.defaultPrevented).toBe(true)
    expect(editor.view.dom.querySelector(".composer-pill-dragging")).toBeNull()
    expect(document.querySelector(".composer-pill-touch-guide")).toBeNull()
  })

  it("leaves movement on an unselected pill to touch scrolling", () => {
    vi.useFakeTimers()
    const editor = createPillEditor()
    const source = editor.view.dom.querySelector<HTMLElement>('[data-type="mention"]')!

    fireEvent.touchStart(source, { touches: [touch(3, 10, 10)] })
    fireEvent.touchMove(document, { touches: [touch(3, 10, 21)] })
    vi.advanceTimersByTime(500)

    expect(childTypes(editor)).toEqual(["mention", "channelLink", "slashCommand"])
    expect(editor.view.dom.querySelector(".composer-pill-dragging")).toBeNull()
    expect(document.querySelector(".composer-pill-touch-guide")).toBeNull()
  })
})
