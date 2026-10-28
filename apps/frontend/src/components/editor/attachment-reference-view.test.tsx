import { describe, it, expect, afterEach, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { useEffect } from "react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import type { Editor } from "@tiptap/core"
import { EditorContent, useEditor } from "@tiptap/react"
import { attachmentContentUrl } from "@/api"
import * as uploadManagerModule from "@/lib/uploads/upload-manager"
import { spyOnExport } from "@/test"
import { createEditorExtensions } from "./editor-extensions"
import type { AttachmentReferenceAttrs } from "./attachment-reference-extension"

const IMAGE: AttachmentReferenceAttrs = {
  id: "attach_01IMG",
  filename: "photo.png",
  mimeType: "image/png",
  sizeBytes: 2048,
  status: "uploaded",
  imageIndex: 1,
  error: null,
  display: "pill",
}

function Harness({ attrs, onReady }: { attrs: AttachmentReferenceAttrs; onReady: (editor: Editor) => void }) {
  const editor = useEditor({
    extensions: createEditorExtensions({ placeholder: "Type a message..." }),
    content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "attachmentReference", attrs }] }] },
  })
  useEffect(() => {
    if (editor) onReady(editor)
  }, [editor, onReady])
  return <EditorContent editor={editor} />
}

function mount(attrs: AttachmentReferenceAttrs): () => Editor {
  let editor: Editor | null = null
  render(
    <MemoryRouter initialEntries={["/w/ws_1"]}>
      <Routes>
        <Route path="/w/:workspaceId" element={<Harness attrs={attrs} onReady={(e) => (editor = e)} />} />
      </Routes>
    </MemoryRouter>
  )
  return () => editor!
}

function nodeAttrs(editor: Editor) {
  return editor.state.doc.firstChild?.firstChild?.attrs
}

async function findInNode<T extends Element = HTMLElement>(selector = "") {
  const query = `[data-type="attachment-reference"] ${selector}`.trim()
  return waitFor(() => {
    const el = document.querySelector<T>(query)
    if (!el) throw new Error(`${query} not rendered`)
    return el
  })
}

function pill(name: string) {
  return findInNode(`button[aria-label="${name}"]`)
}

describe("AttachmentReferenceView", () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it("should set display to inline when Show as image is chosen from an image pill", async () => {
    const getEditor = mount(IMAGE)
    fireEvent.click(await pill("photo.png"))
    fireEvent.click(await screen.findByRole("button", { name: "Show as image" }))
    expect(nodeAttrs(getEditor())).toEqual({ ...IMAGE, display: "inline" })
    await waitFor(() => expect(screen.queryByRole("button", { name: "Show as image" })).toBeNull())
  })

  it("should return focus to the composer after the pill when the action is chosen", async () => {
    const getEditor = mount(IMAGE)
    fireEvent.click(await pill("photo.png"))
    fireEvent.click(await screen.findByRole("button", { name: "Show as image" }))
    await waitFor(() => expect(getEditor().isFocused).toBe(true))
    expect({
      caret: getEditor().state.selection.from,
      tooltip: document.querySelector('[role="tooltip"]'),
    }).toEqual({ caret: 2, tooltip: null })
  })

  it("should return focus to the composer after the pill without opening the tooltip when Escape closes the popover", async () => {
    const getEditor = mount(IMAGE)
    fireEvent.click(await pill("photo.png"))
    const action = await screen.findByRole("button", { name: "Show as image" })
    fireEvent.keyDown(action, { key: "Escape" })
    await waitFor(() =>
      expect({
        action: screen.queryByRole("button", { name: "Show as image" }),
        focused: getEditor().isFocused,
        caret: getEditor().state.selection.from,
        tooltip: document.querySelector('[role="tooltip"]'),
      }).toEqual({ action: null, focused: true, caret: 2, tooltip: null })
    )
  })

  it("should leave the composer unfocused when a press outside dismisses the popover", async () => {
    const getEditor = mount(IMAGE)
    fireEvent.click(await pill("photo.png"))
    await screen.findByRole("button", { name: "Show as image" })
    // Radix registers its outside-press listener a tick after opening.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
    fireEvent.pointerDown(document.body)
    await waitFor(() => expect(screen.queryByRole("button", { name: "Show as image" })).toBeNull())
    // The composer focuses on the next animation frame; give it two.
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(getEditor().isFocused).toBe(false)
  })

  it("should keep display inline when the upload settles after the switch", async () => {
    const getEditor = mount({ ...IMAGE, id: "temp_1", status: "uploading" })
    fireEvent.click(await pill("photo.png"))
    fireEvent.click(await screen.findByRole("button", { name: "Show as image" }))
    act(() => {
      getEditor().commands.updateAttachmentReference("temp_1", { id: IMAGE.id, status: "uploaded" })
    })
    await findInNode("img")
    expect(nodeAttrs(getEditor())).toEqual({ ...IMAGE, display: "inline" })
  })

  it("should render the thumbnail when an inline image is uploaded", async () => {
    mount({ ...IMAGE, display: "inline" })
    const img = await findInNode<HTMLImageElement>("img")
    expect({ src: img.getAttribute("src"), alt: img.alt }).toEqual({
      src: attachmentContentUrl("ws_1", IMAGE.id, { variant: "thumbnail" }),
      alt: "photo.png",
    })
  })

  it("should render the upload's local preview when the attachment's bytes may still be uploading", async () => {
    spyOnExport(uploadManagerModule, "getUploadJobByAttachmentId").mockReturnValue(((id: string) =>
      id === IMAGE.id
        ? { previewUrl: "blob:local-preview" }
        : undefined) as unknown as typeof uploadManagerModule.getUploadJobByAttachmentId)
    mount({ ...IMAGE, display: "inline" })
    const img = await findInNode<HTMLImageElement>("img")
    expect(img.getAttribute("src")).toBe("blob:local-preview")
  })

  it("should replace the skeleton with an unavailable notice when the image fails to load", async () => {
    mount({ ...IMAGE, display: "inline" })
    fireEvent.error(await findInNode("img"))
    await waitFor(() => expect(screen.queryByText("Image unavailable")).not.toBeNull())
    expect({
      img: document.querySelector('[data-type="attachment-reference"] img'),
      skeleton: document.querySelector('[data-type="attachment-reference"] .animate-pulse'),
    }).toEqual({ img: null, skeleton: null })
  })

  it("should render the chip when an inline image is still uploading", async () => {
    mount({ ...IMAGE, display: "inline", status: "uploading" })
    await pill("photo.png")
    expect({
      img: document.querySelector('[data-type="attachment-reference"] img'),
      label: screen.queryByText("[Uploading...]") !== null,
    }).toEqual({ img: null, label: true })
  })

  it("should set display back to pill when Show as chip is chosen from an inline image", async () => {
    const getEditor = mount({ ...IMAGE, display: "inline" })
    fireEvent.click(await pill("photo.png"))
    fireEvent.click(await screen.findByRole("button", { name: "Show as chip" }))
    expect(nodeAttrs(getEditor())).toEqual({ ...IMAGE, display: "pill" })
  })

  it("should open no popover when a non-image pill is clicked", async () => {
    mount({ ...IMAGE, filename: "notes.txt", mimeType: "text/plain" })
    const chip = await findInNode()
    await act(async () => fireEvent.click(chip))
    expect({
      button: chip.querySelector("button"),
      dialog: screen.queryByRole("dialog"),
    }).toEqual({ button: null, dialog: null })
  })
})
