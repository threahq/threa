import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { Editor } from "@tiptap/react"
import { NodeSelection } from "@tiptap/pm/state"
import type { JSONContent } from "@threahq/types"
import { ComposerPillDragPluginKey } from "./composer-pill-drag-extension"
import { ComposerPillActions } from "./composer-pill-actions"
import { createEditorExtensions } from "./editor-extensions"
import { MediaViewerContext } from "./media-viewer-context"

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

function selectPill(editor: Editor, type = "mention") {
  act(() => {
    editor.commands.setNodeSelection(nodePos(editor, type))
  })
}

function attachmentPill(mimeType: string): JSONContent {
  return {
    type: "attachmentReference",
    attrs: {
      id: "attach_01IMG",
      filename: "photo.png",
      mimeType,
      sizeBytes: 2048,
      status: "uploaded",
      imageIndex: 1,
      error: null,
      display: "pill",
    },
  }
}

function actionLabels() {
  return screen.queryAllByRole("button").map((button) => button.getAttribute("aria-label"))
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

describe("ComposerPillActions", () => {
  it("should copy exactly the selected pill's canonical markdown when Copy is tapped", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubClipboard(writeText)
    const editor = createPillEditor()
    render(<ComposerPillActions editor={editor} />)

    selectPill(editor)
    const control = copyControl()
    expect(control).not.toBeNull()

    fireEvent.click(control!)
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("[@alice](user:usr_1)"))
    expect(writeText).toHaveBeenCalledTimes(1)
  })

  it("should confirm in place without resizing the control when the copy succeeds", async () => {
    stubClipboard(vi.fn().mockResolvedValue(undefined))
    const editor = createPillEditor()
    render(<ComposerPillActions editor={editor} />)

    selectPill(editor)
    const control = copyControl()!
    const beforeClass = control.className

    fireEvent.click(control)
    await waitFor(() => expect(screen.getByRole("button", { name: /pill copied/i })).toBe(control))
    expect(control.className).toBe(beforeClass)
  })

  it("should warn instead of confirming when the clipboard rejects", async () => {
    const { toast } = await import("sonner")
    const error = vi.spyOn(toast, "error").mockReturnValue("id")
    stubClipboard(vi.fn().mockRejectedValue(new Error("denied")))
    const editor = createPillEditor()
    render(<ComposerPillActions editor={editor} />)

    selectPill(editor)
    fireEvent.click(copyControl()!)

    await waitFor(() => expect(error).toHaveBeenCalled())
    expect(screen.queryByRole("button", { name: /pill copied/i })).toBeNull()
  })

  it("should keep the press off the document when a control is pressed, so the pill keeps its selection", () => {
    const editor = createPillEditor()
    render(<ComposerPillActions editor={editor} />)

    selectPill(editor)
    const pointerDown = new Event("pointerdown", { bubbles: true, cancelable: true })
    copyControl()!.dispatchEvent(pointerDown)

    expect(pointerDown.defaultPrevented).toBe(true)
  })

  it("should offer nothing when the selection is text, the pointer is a mouse, or a drag is in flight", () => {
    const editor = createPillEditor()
    render(<ComposerPillActions editor={editor} />)

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

  it("should show the display toggle beside Copy when the selected pill is an image", () => {
    const editor = createPillEditor([attachmentPill("image/png")])
    render(<ComposerPillActions editor={editor} />)

    selectPill(editor, "attachmentReference")
    expect(actionLabels()).toEqual(["Copy pill", "Show as image"])
  })

  it("should flip display to inline and keep the pill selected when Show as image is tapped", () => {
    const editor = createPillEditor([attachmentPill("image/png")])
    render(<ComposerPillActions editor={editor} />)
    const pos = nodePos(editor, "attachmentReference")

    selectPill(editor, "attachmentReference")
    fireEvent.click(screen.getByRole("button", { name: "Show as image" }))

    const { selection } = editor.state
    expect({
      display: editor.state.doc.nodeAt(pos)?.attrs.display,
      nodeSelection: selection instanceof NodeSelection,
      from: selection.from,
      labels: actionLabels(),
    }).toEqual({ display: "inline", nodeSelection: true, from: pos, labels: ["Copy pill", "Show as chip"] })
  })

  it("should open the image and take the bar down when Open is tapped on a surface with a gallery", () => {
    const editor = createPillEditor([attachmentPill("image/png")])
    const open = vi.fn()
    render(
      <MediaViewerContext.Provider value={{ open, readOnly: false }}>
        <ComposerPillActions editor={editor} />
      </MediaViewerContext.Provider>
    )

    selectPill(editor, "attachmentReference")
    const labelsWhenSelected = actionLabels()
    fireEvent.click(screen.getByRole("button", { name: "Open" }))

    expect({ labelsWhenSelected, opened: open.mock.calls, labelsAfter: actionLabels() }).toEqual({
      labelsWhenSelected: ["Copy pill", "Open", "Show as image"],
      opened: [["attach_01IMG"]],
      labelsAfter: [],
    })
  })

  it("should show only Copy when the selected pill is not an image", () => {
    const editor = createPillEditor([attachmentPill("application/pdf")])
    render(<ComposerPillActions editor={editor} />)

    selectPill(editor, "attachmentReference")
    expect(actionLabels()).toEqual(["Copy pill"])
  })

  it("should offer Open for a file and Open plus the video toggle for a video when the surface has a gallery", () => {
    const labelsFor = (mimeType: string, viewer: boolean) => {
      const editor = createPillEditor([attachmentPill(mimeType)])
      const bar = <ComposerPillActions editor={editor} />
      const { unmount } = render(
        viewer ? (
          <MediaViewerContext.Provider value={{ open: vi.fn(), readOnly: false }}>{bar}</MediaViewerContext.Provider>
        ) : (
          bar
        )
      )
      selectPill(editor, "attachmentReference")
      const labels = actionLabels()
      unmount()
      return labels
    }

    expect({
      docPdf: labelsFor("application/pdf", true),
      docVideo: labelsFor("video/mp4", true),
      composerVideo: labelsFor("video/mp4", false),
    }).toEqual({
      docPdf: ["Copy pill", "Open"],
      docVideo: ["Copy pill", "Open", "Show as video"],
      composerVideo: ["Copy pill"],
    })
  })

  it("should keep the bar half its width from the viewport edge when the pill sits at either edge", () => {
    const editor = createPillEditor([attachmentPill("image/png")])
    render(<ComposerPillActions editor={editor} />)
    const pillDom = editor.view.nodeDOM(nodePos(editor, "attachmentReference")) as HTMLElement
    const rect = vi.spyOn(pillDom, "getBoundingClientRect")
    const barLeftAt = (x: number) => {
      rect.mockReturnValue(new DOMRect(x, 300, 0, 20))
      selectPill(editor, "attachmentReference")
      act(() => {
        window.dispatchEvent(new Event("resize"))
      })
      return screen.getByRole("button", { name: "Copy pill" }).parentElement!.style.left
    }
    const halfBar = (2 * 40 + 8) / 2

    expect({ start: barLeftAt(0), end: barLeftAt(window.innerWidth) }).toEqual({
      start: `${halfBar}px`,
      end: `${window.innerWidth - halfBar}px`,
    })
  })
})
