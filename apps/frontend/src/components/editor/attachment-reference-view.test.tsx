import { describe, it, expect, afterEach } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { useEffect } from "react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import type { Editor } from "@tiptap/core"
import { EditorContent, useEditor } from "@tiptap/react"
import { attachmentContentUrl } from "@/api"
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

async function pill(name: string) {
  return waitFor(() => {
    const el = document.querySelector<HTMLElement>(`[data-type="attachment-reference"] button[aria-label="${name}"]`)
    if (!el) throw new Error("pill not rendered")
    return el
  })
}

describe("AttachmentReferenceView", () => {
  afterEach(cleanup)

  it("should set display to inline when Show as image is chosen from an image pill", async () => {
    const getEditor = mount(IMAGE)
    fireEvent.click(await pill("photo.png"))
    fireEvent.click(await screen.findByRole("button", { name: "Show as image" }))
    expect(nodeAttrs(getEditor())).toEqual({ ...IMAGE, display: "inline" })
    await waitFor(() => expect(screen.queryByRole("button", { name: "Show as image" })).toBeNull())
  })

  it("should render the thumbnail when an inline image is uploaded", async () => {
    mount({ ...IMAGE, display: "inline" })
    const img = await waitFor(() => {
      const el = document.querySelector<HTMLImageElement>('[data-type="attachment-reference"] img')
      if (!el) throw new Error("no img")
      return el
    })
    expect({ src: img.getAttribute("src"), alt: img.alt }).toEqual({
      src: attachmentContentUrl("ws_1", IMAGE.id, { variant: "thumbnail" }),
      alt: "photo.png",
    })
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
    const chip = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-type="attachment-reference"]')
      if (!el) throw new Error("no chip")
      return el
    })
    await act(async () => fireEvent.click(chip))
    expect({
      button: chip.querySelector("button"),
      dialog: screen.queryByRole("dialog"),
    }).toEqual({ button: null, dialog: null })
  })
})
