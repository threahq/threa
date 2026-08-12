import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render } from "@testing-library/react"
import { Editor } from "@tiptap/core"
import { NodeSelection } from "@tiptap/pm/state"
import type { JSONContent } from "@threa/types"
import { serializeClipboardSlice } from "./clipboard-copy"
import { ComposerPillDndProvider } from "./composer-pill-dnd"
import { createEditorExtensions } from "./editor-extensions"
import {
  COMPOSER_PILL_NODE_NAMES,
  ComposerPillDragPluginKey,
  composerPillDropPoint,
  createComposerPillMoveTransaction,
  dropPositionAt,
  isComposerPillNode,
} from "./composer-pill-drag-extension"

const openEditors: Editor[] = []
let originalVibrateDescriptor: PropertyDescriptor | undefined
let vibrateMocked = false

/**
 * The gesture layer lives in React now, so an editor only drags once its
 * dnd-kit provider is mounted around it.
 */
function mountPillDnd(editor: Editor) {
  render(<ComposerPillDndProvider editor={editor} />)
}

afterEach(() => {
  cleanup()
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
  mountPillDnd(editor)
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

  it("paints pills a text selection covers and leaves the ones it stops short of", () => {
    const editor = createPillEditor([pill("mention"), { type: "text", text: "hi" }, pill("channelLink")])
    const mentionPos = nodePos(editor, "mention")
    const channelPos = nodePos(editor, "channelLink")

    editor.commands.setTextSelection({ from: mentionPos, to: channelPos })
    expect(editor.view.dom.querySelectorAll(".composer-pill-in-selection")).toHaveLength(1)
    expect(editor.view.dom.querySelector('[data-type="mention"]')).toHaveClass("composer-pill-in-selection")

    editor.commands.setTextSelection({ from: mentionPos, to: channelPos + 1 })
    expect(editor.view.dom.querySelectorAll(".composer-pill-in-selection")).toHaveLength(2)

    editor.commands.setNodeSelection(mentionPos)
    expect(editor.view.dom.querySelectorAll(".composer-pill-in-selection")).toHaveLength(0)
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
  it("exposes the active touch drag mode on the editor root", () => {
    const editor = createPillEditor()

    expect(editor.view.dom).toHaveAttribute("data-composer-pill-drag-mode", "hold-or-selected")
  })

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

  it("drops the pill where the pointer was released, not where the last move landed", () => {
    const editor = createPillEditor()
    const source = editor.view.dom.querySelector<HTMLElement>('[data-type="mention"]')!
    const midPos = nodePos(editor, "slashCommand")
    const endPos = midPos + 1
    vi.spyOn(editor.view, "posAtCoords").mockImplementation(({ left }) => ({
      pos: left >= 30 ? endPos : midPos,
      inside: -1,
    }))

    fireEvent.mouseDown(source, { button: 0, clientX: 10, clientY: 10 })
    fireEvent.mouseMove(document, { buttons: 1, clientX: 18, clientY: 10 })
    expect(ComposerPillDragPluginKey.getState(editor.state)?.dropPos).toBe(midPos)

    fireEvent.mouseUp(source, { button: 0, clientX: 40, clientY: 10 })
    expect(childTypes(editor)).toEqual(["channelLink", "slashCommand", "mention"])
  })

  it("suppresses the ending touch's compatibility mouse even after a stray mouse press", () => {
    vi.useFakeTimers()
    const editor = createPillEditor()
    const source = editor.view.dom.querySelector<HTMLElement>('[data-type="mention"]')!

    fireEvent.touchStart(source, { touches: [touch(7, 10, 10)] })
    vi.advanceTimersByTime(500)
    expect(editor.view.dom.querySelector(".composer-pill-dragging")).not.toBeNull()

    vi.advanceTimersByTime(401)
    const strayMouseDown = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 10,
      clientY: 10,
    })
    source.dispatchEvent(strayMouseDown)
    expect(strayMouseDown.defaultPrevented).toBe(false)

    fireEvent.keyDown(document, { key: "Escape" })
    expect(editor.view.dom.querySelector(".composer-pill-dragging")).toBeNull()

    vi.advanceTimersByTime(401)
    fireEvent.touchEnd(document, { touches: [], changedTouches: [touch(7, 10, 10)] })
    const compatibilityMouseDown = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 10,
      clientY: 10,
    })
    editor.view.dom.querySelector<HTMLElement>('[data-type="mention"]')!.dispatchEvent(compatibilityMouseDown)

    expect(compatibilityMouseDown.defaultPrevented).toBe(true)
    expect(childTypes(editor)).toEqual(["mention", "channelLink", "slashCommand"])
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

  it("claims an unselected native long press, then selects the pill on stationary release", () => {
    vi.useFakeTimers()
    const editor = createPillEditor()
    const source = editor.view.dom.querySelector<HTMLElement>('[data-type="mention"]')!

    fireEvent.touchStart(source, { touches: [touch(7, 10, 10)] })
    const selectStart = new Event("selectstart", { bubbles: true, cancelable: true })
    source.dispatchEvent(selectStart)
    expect(selectStart.defaultPrevented).toBe(true)

    const contextMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true })
    source.dispatchEvent(contextMenu)
    expect(contextMenu.defaultPrevented).toBe(true)
    expect(editor.view.dom.querySelector(".composer-pill-dragging")).not.toBeNull()
    expect(document.querySelector(".composer-pill-touch-guide")).not.toBeNull()

    fireEvent.touchEnd(document, { touches: [], changedTouches: [touch(7, 10, 10)] })
    expect(editor.state.selection).toBeInstanceOf(NodeSelection)
    expect(editor.state.selection.from).toBe(nodePos(editor, "mention"))
    expect(editor.view.dom.querySelector(".composer-pill-dragging")).toBeNull()
    expect(document.querySelector(".composer-pill-touch-guide")).toBeNull()
  })

  it("guards held release selection from delayed compatibility mouse events", () => {
    vi.useFakeTimers()
    const editor = createPillEditor()
    const source = editor.view.dom.querySelector<HTMLElement>('[data-type="mention"]')!

    fireEvent.touchStart(source, { touches: [touch(7, 10, 10)] })
    vi.advanceTimersByTime(1_302)
    fireEvent.touchEnd(document, { touches: [], changedTouches: [touch(7, 10, 10)] })

    const selectedSource = editor.view.dom.querySelector<HTMLElement>('[data-type="mention"]')!
    const compatibilityMouseDown = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 10,
      clientY: 10,
    })
    selectedSource.dispatchEvent(compatibilityMouseDown)
    fireEvent.mouseUp(selectedSource, { button: 0, clientX: 10, clientY: 10 })
    fireEvent.click(selectedSource)

    expect(compatibilityMouseDown.defaultPrevented).toBe(true)
    expect(editor.state.selection).toBeInstanceOf(NodeSelection)
    expect(selectedSource).toHaveClass("ProseMirror-selectednode")
  })

  it("claims a selected pill's stationary hold instead of offering native selection", () => {
    vi.useFakeTimers()
    const editor = createPillEditor()
    const source = editor.view.dom.querySelector<HTMLElement>('[data-type="mention"]')!

    tapPill(source)
    fireEvent.touchStart(source, { touches: [touch(7, 10, 10)] })
    const selectStart = new Event("selectstart", { bubbles: true, cancelable: true })
    source.dispatchEvent(selectStart)
    expect(selectStart.defaultPrevented).toBe(true)

    vi.advanceTimersByTime(500)
    expect(editor.view.dom.querySelector(".composer-pill-dragging")).not.toBeNull()
    expect(document.querySelector(".composer-pill-touch-guide")).not.toBeNull()

    fireEvent.touchEnd(document, { touches: [], changedTouches: [touch(7, 10, 10)] })
    expect(editor.state.selection).toBeInstanceOf(NodeSelection)
    expect(editor.state.selection.from).toBe(nodePos(editor, "mention"))
    expect(editor.view.dom.querySelector(".composer-pill-dragging")).toBeNull()
  })

  it("claims a selected pill's context menu rather than standing down for it", () => {
    vi.useFakeTimers()
    const editor = createPillEditor()
    const source = editor.view.dom.querySelector<HTMLElement>('[data-type="mention"]')!

    tapPill(source)
    fireEvent.touchStart(source, { touches: [touch(7, 10, 10)] })
    const contextMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true })
    source.dispatchEvent(contextMenu)

    expect(contextMenu.defaultPrevented).toBe(true)
    expect(editor.view.dom.querySelector(".composer-pill-dragging")).not.toBeNull()

    fireEvent.touchEnd(document, { touches: [], changedTouches: [touch(7, 10, 10)] })
    expect(editor.state.selection).toBeInstanceOf(NodeSelection)
    expect(editor.state.selection.from).toBe(nodePos(editor, "mention"))
  })

  it("does not select an unselected claimed hold after touchcancel", () => {
    vi.useFakeTimers()
    const editor = createPillEditor()
    const source = editor.view.dom.querySelector<HTMLElement>('[data-type="mention"]')!

    fireEvent.touchStart(source, { touches: [touch(7, 10, 10)] })
    vi.advanceTimersByTime(500)
    expect(editor.view.dom.querySelector(".composer-pill-dragging")).not.toBeNull()

    fireEvent.touchCancel(document)
    expect(editor.state.selection).not.toBeInstanceOf(NodeSelection)
    expect(editor.view.dom.querySelector(".composer-pill-dragging")).toBeNull()
    expect(document.querySelector(".composer-pill-touch-guide")).toBeNull()
  })

  it("keeps a claimed hold at its source until movement crosses tolerance", () => {
    vi.useFakeTimers()
    const editor = createPillEditor()
    const source = editor.view.dom.querySelector<HTMLElement>('[data-type="mention"]')!
    vi.spyOn(editor.view, "posAtCoords").mockReturnValue({ pos: nodePos(editor, "slashCommand") + 1, inside: -1 })

    fireEvent.touchStart(source, { touches: [touch(7, 10, 10)] })
    vi.advanceTimersByTime(500)
    const initialDropPos = ComposerPillDragPluginKey.getState(editor.state)?.dropPos
    fireEvent.touchMove(document, { touches: [touch(7, 15, 10)] })

    expect(ComposerPillDragPluginKey.getState(editor.state)?.dropPos).toBe(initialDropPos)
    fireEvent.touchEnd(document, { touches: [], changedTouches: [touch(7, 15, 10)] })
    expect(editor.state.selection).toBeInstanceOf(NodeSelection)
    expect(childTypes(editor)).toEqual(["mention", "channelLink", "slashCommand"])
  })

  it("selects the mapped pill after the document changes during a claimed hold", () => {
    vi.useFakeTimers()
    const editor = createPillEditor()
    const source = editor.view.dom.querySelector<HTMLElement>('[data-type="mention"]')!

    fireEvent.touchStart(source, { touches: [touch(7, 10, 10)] })
    vi.advanceTimersByTime(500)
    editor.view.dispatch(editor.state.tr.insertText("x ", 1))
    const mappedSourcePos = nodePos(editor, "mention")
    expect(ComposerPillDragPluginKey.getState(editor.state)?.source).toEqual({ kind: "doc", pos: mappedSourcePos })

    fireEvent.touchEnd(document, { touches: [], changedTouches: [touch(7, 10, 10)] })
    expect(editor.state.selection).toBeInstanceOf(NodeSelection)
    expect(editor.state.selection.from).toBe(mappedSourcePos)
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
    expect(editor.view.dom.querySelector(".composer-pill-dragging")).not.toBeNull()
    const contextMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true })
    source.dispatchEvent(contextMenu)
    expect(contextMenu.defaultPrevented).toBe(true)

    fireEvent.touchMove(document, { touches: [touch(7, 21, 10)] })
    expect(editor.view.dom.querySelector(".composer-pill-dragging")).not.toBeNull()

    fireEvent.touchEnd(document, { touches: [], changedTouches: [touch(7, 21, 10)] })
    expect(childTypes(editor)).toEqual(["channelLink", "slashCommand", "mention"])
  })

  it("drags an already-selected pill before the hold timer fires", () => {
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
    const selectStart = new Event("selectstart", { bubbles: true, cancelable: true })
    source.dispatchEvent(selectStart)

    expect(selectStart.defaultPrevented).toBe(false)
    expect(childTypes(editor)).toEqual(["mention", "channelLink", "slashCommand"])
    expect(editor.view.dom.querySelector(".composer-pill-dragging")).toBeNull()
    expect(document.querySelector(".composer-pill-touch-guide")).toBeNull()
  })
})

describe("composer pill drop points", () => {
  it("snaps a raw pointer position to the nearest token boundary", () => {
    const editor = createPillEditor([pill("mention"), { type: "text", text: "hello world" }])
    const source = editor.state.doc.nodeAt(nodePos(editor, "mention"))!
    vi.spyOn(editor.view, "posAtCoords").mockReturnValue({ pos: 5, inside: -1 })

    expect(dropPositionAt(editor.view, 40, 10, source)).toBe(7)
  })

  it("splits a hovered pill at its midpoint instead of asking for a text position", () => {
    const editor = createPillEditor()
    const source = editor.state.doc.nodeAt(nodePos(editor, "mention"))!
    const hovered = editor.view.dom.querySelector<HTMLElement>('[data-type="channelLink"]')!
    const hoveredPos = nodePos(editor, "channelLink")
    vi.spyOn(hovered, "getBoundingClientRect").mockReturnValue({ left: 100, width: 20 } as DOMRect)
    vi.spyOn(document, "elementFromPoint").mockReturnValue(hovered)
    const posAtCoords = vi.spyOn(editor.view, "posAtCoords")

    expect(dropPositionAt(editor.view, 104, 10, source)).toBe(hoveredPos)
    expect(dropPositionAt(editor.view, 116, 10, source)).toBe(hoveredPos + 1)
    expect(posAtCoords).not.toHaveBeenCalled()
  })

  it("offers no drop position for a pointer outside the editor", () => {
    const editor = createPillEditor()
    const source = editor.state.doc.nodeAt(nodePos(editor, "mention"))!
    vi.spyOn(document, "elementFromPoint").mockReturnValue(document.body)

    expect(dropPositionAt(editor.view, 900, 900, source)).toBeNull()
  })
})

describe("composer pill drag sensor", () => {
  function isDragging(editor: Editor): boolean {
    return editor.view.dom.querySelector(".composer-pill-dragging") !== null
  }

  it("holds a mouse press until it travels the activation threshold", () => {
    const editor = createPillEditor()
    const source = editor.view.dom.querySelector<HTMLElement>('[data-type="mention"]')!

    fireEvent.mouseDown(source, { button: 0, clientX: 10, clientY: 10 })
    fireEvent.mouseMove(document, { buttons: 1, clientX: 15, clientY: 10 })
    expect(isDragging(editor)).toBe(false)

    fireEvent.mouseMove(document, { buttons: 1, clientX: 16, clientY: 10 })
    expect(isDragging(editor)).toBe(true)
  })

  it("activates an unselected pill only on the long-press threshold", () => {
    vi.useFakeTimers()
    const editor = createPillEditor()
    const source = editor.view.dom.querySelector<HTMLElement>('[data-type="mention"]')!

    fireEvent.touchStart(source, { touches: [touch(1, 10, 10)] })
    vi.advanceTimersByTime(499)
    expect(isDragging(editor)).toBe(false)

    vi.advanceTimersByTime(1)
    expect(isDragging(editor)).toBe(true)
  })

  it("activates a selected pill on movement and leaves an unselected one alone", () => {
    const selected = createPillEditor()
    const selectedSource = selected.view.dom.querySelector<HTMLElement>('[data-type="mention"]')!
    tapPill(selectedSource)
    fireEvent.touchStart(selectedSource, { touches: [touch(1, 10, 10)] })
    fireEvent.touchMove(document, { touches: [touch(1, 21, 10)] })
    expect(isDragging(selected)).toBe(true)

    const unselected = createPillEditor()
    const unselectedSource = unselected.view.dom.querySelector<HTMLElement>('[data-type="mention"]')!
    fireEvent.touchStart(unselectedSource, { touches: [touch(2, 10, 10)] })
    fireEvent.touchMove(document, { touches: [touch(2, 21, 10)] })
    expect(isDragging(unselected)).toBe(false)
  })

  it("cancels an in-flight drag on Escape, on window blur, and on a second finger", () => {
    vi.useFakeTimers()
    const editor = createPillEditor()
    const source = () => editor.view.dom.querySelector<HTMLElement>('[data-type="mention"]')!

    fireEvent.mouseDown(source(), { button: 0, clientX: 10, clientY: 10 })
    fireEvent.mouseMove(document, { buttons: 1, clientX: 18, clientY: 10 })
    expect(isDragging(editor)).toBe(true)
    fireEvent.keyDown(document, { key: "Escape" })
    expect(isDragging(editor)).toBe(false)

    fireEvent.mouseDown(source(), { button: 0, clientX: 10, clientY: 10 })
    fireEvent.mouseMove(document, { buttons: 1, clientX: 18, clientY: 10 })
    expect(isDragging(editor)).toBe(true)
    fireEvent.blur(window)
    expect(isDragging(editor)).toBe(false)

    fireEvent.mouseUp(document, { button: 0, clientX: 18, clientY: 10 })
    fireEvent.touchStart(source(), { touches: [touch(9, 10, 10)] })
    vi.advanceTimersByTime(500)
    expect(isDragging(editor)).toBe(true)
    fireEvent.touchStart(document.body, { touches: [touch(9, 10, 10), touch(10, 50, 50)] })
    expect(isDragging(editor)).toBe(false)
    expect(childTypes(editor)).toEqual(["mention", "channelLink", "slashCommand"])
  })
})
