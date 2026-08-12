import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { Editor } from "@tiptap/react"
import type { JSONContent } from "@threa/types"
import { ComposerPillDragPluginKey } from "./composer-pill-drag-extension"
import { ComposerPillCopyButton } from "./composer-pill-copy-button"
import { createEditorExtensions } from "./editor-extensions"

const openEditors: Editor[] = []
let originalClipboardDescriptor: PropertyDescriptor | undefined
let clipboardStubbed = false

// Only the clipboard is replaced: spreading `navigator` drops everything on its
// prototype, and TipTap reads `userAgent` while building its keymap.
function stubClipboard(writeText: () => Promise<void>) {
  originalClipboardDescriptor ??= Object.getOwnPropertyDescriptor(navigator, "clipboard")
  clipboardStubbed = true
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
}

function setInputMode(pointerType: "touch" | "mouse") {
  const event = new Event("pointerdown", { bubbles: true })
  Object.defineProperty(event, "pointerType", { value: pointerType })
  act(() => {
    window.dispatchEvent(event)
  })
}

function createPillEditor(
  content: JSONContent[] = [
    { type: "mention", attrs: { id: "usr_1", slug: "alice", mentionType: "user" } },
    { type: "text", text: " hello" },
  ]
) {
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

function selectPill(editor: Editor) {
  act(() => {
    editor.commands.setNodeSelection(nodePos(editor, "mention"))
  })
}

function copyControl() {
  return screen.queryByRole("button", { name: /pill/i })
}

beforeEach(() => {
  setInputMode("touch")
})

afterEach(() => {
  while (openEditors.length > 0) {
    const editor = openEditors.pop()!
    const element = editor.view.dom.parentElement
    editor.destroy()
    element?.remove()
  }
  setInputMode("mouse")
  if (clipboardStubbed) {
    if (originalClipboardDescriptor) Object.defineProperty(navigator, "clipboard", originalClipboardDescriptor)
    else delete (navigator as unknown as { clipboard?: Clipboard }).clipboard
    originalClipboardDescriptor = undefined
    clipboardStubbed = false
  }
  vi.restoreAllMocks()
})

describe("composer pill copy control", () => {
  it("copies exactly the selected pill's canonical markdown", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubClipboard(writeText)
    const editor = createPillEditor()
    render(<ComposerPillCopyButton editor={editor} />)

    selectPill(editor)
    const control = copyControl()
    expect(control).not.toBeNull()

    fireEvent.click(control!)
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("[@alice](user:usr_1)"))
    expect(writeText).toHaveBeenCalledTimes(1)
  })

  it("confirms in place without resizing the control", async () => {
    stubClipboard(vi.fn().mockResolvedValue(undefined))
    const editor = createPillEditor()
    render(<ComposerPillCopyButton editor={editor} />)

    selectPill(editor)
    const control = copyControl()!
    const beforeClass = control.className

    fireEvent.click(control)
    await waitFor(() => expect(screen.getByRole("button", { name: /pill copied/i })).toBe(control))
    expect(control.className).toBe(beforeClass)
  })

  it("warns instead of confirming when the clipboard rejects", async () => {
    const { toast } = await import("sonner")
    const error = vi.spyOn(toast, "error").mockReturnValue("id")
    stubClipboard(vi.fn().mockRejectedValue(new Error("denied")))
    const editor = createPillEditor()
    render(<ComposerPillCopyButton editor={editor} />)

    selectPill(editor)
    fireEvent.click(copyControl()!)

    await waitFor(() => expect(error).toHaveBeenCalled())
    expect(screen.queryByRole("button", { name: /pill copied/i })).toBeNull()
  })

  it("keeps the press off the document so the pill keeps its selection", () => {
    const editor = createPillEditor()
    render(<ComposerPillCopyButton editor={editor} />)

    selectPill(editor)
    const pointerDown = new Event("pointerdown", { bubbles: true, cancelable: true })
    copyControl()!.dispatchEvent(pointerDown)

    expect(pointerDown.defaultPrevented).toBe(true)
  })

  it("offers nothing for a text selection, a mouse, or a drag in flight", () => {
    const editor = createPillEditor()
    render(<ComposerPillCopyButton editor={editor} />)

    act(() => {
      editor.commands.setTextSelection(nodePos(editor, "mention") + 2)
    })
    expect(copyControl()).toBeNull()

    selectPill(editor)
    expect(copyControl()).not.toBeNull()

    act(() => {
      editor.view.dispatch(
        editor.state.tr.setMeta(ComposerPillDragPluginKey, {
          source: { kind: "doc", pos: nodePos(editor, "mention") },
          dropPos: null,
        })
      )
    })
    expect(copyControl()).toBeNull()

    act(() => {
      editor.view.dispatch(editor.state.tr.setMeta(ComposerPillDragPluginKey, null))
    })
    expect(copyControl()).not.toBeNull()

    setInputMode("mouse")
    expect(copyControl()).toBeNull()
  })
})
