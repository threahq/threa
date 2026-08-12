import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { Editor } from "@tiptap/core"
import type { JSONContent } from "@threa/types"
import { ComposerPillDndProvider } from "@/components/editor/composer-pill-dnd"
import { countAttachmentReferences } from "@/components/editor/attachment-reference-counts"
import { createEditorExtensions } from "@/components/editor/editor-extensions"
import type { PendingAttachment } from "@/hooks/use-attachments"
import * as useMobileModule from "@/hooks/use-mobile"
import { extractUploadedAttachments, materializePendingAttachmentReferences } from "./message-input"
import { PendingAttachments } from "./pending-attachments"

const openEditors: Editor[] = []

afterEach(() => {
  cleanup()
  while (openEditors.length > 0) {
    const editor = openEditors.pop()!
    const element = editor.view.dom.parentElement
    editor.destroy()
    element?.remove()
  }
  vi.restoreAllMocks()
})

function attachment(overrides: Partial<PendingAttachment> = {}): PendingAttachment {
  return {
    id: "att_1",
    filename: "screenshot.png",
    mimeType: "image/png",
    sizeBytes: 2048,
    status: "uploaded",
    previewUrl: "blob:preview-1",
    ...overrides,
  }
}

function createEditor(content: JSONContent[] = [{ type: "text", text: "hello world" }]) {
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

function childTypes(editor: Editor): string[] {
  return editor.state.doc.firstChild?.content.content.map((node) => node.type.name) ?? []
}

/** Mount the tray inside the editor's drag context, the way the composer does. */
function renderTray(editor: Editor, attachments: PendingAttachment[], onRemove = vi.fn()) {
  return render(
    <ComposerPillDndProvider editor={editor}>
      <PendingAttachments attachments={attachments} onRemove={onRemove} workspaceId="ws_1" />
    </ComposerPillDndProvider>
  )
}

function dragChipIntoEditor(chip: HTMLElement, startX = 10) {
  fireEvent.mouseDown(chip, { button: 0, clientX: startX, clientY: 10 })
  fireEvent.mouseMove(document, { buttons: 1, clientX: startX + 20, clientY: 10 })
  fireEvent.mouseUp(document, { button: 0, clientX: startX + 20, clientY: 10 })
}

describe("tray pill drag", () => {
  it("inserts a reference per drag and leaves the chip in the tray", () => {
    const editor = createEditor()
    vi.spyOn(editor.view, "posAtCoords").mockReturnValue({ pos: 1, inside: -1 })
    renderTray(editor, [attachment()])

    const chip = screen.getByText("screenshot.png")
    dragChipIntoEditor(chip)
    expect(childTypes(editor)).toEqual(["attachmentReference", "text"])

    dragChipIntoEditor(screen.getByText("screenshot.png"))
    expect(childTypes(editor).filter((type) => type === "attachmentReference")).toHaveLength(2)
    // The tray is an inventory, not a queue: the chip survives both drags.
    expect(screen.getByText("screenshot.png")).toBeInTheDocument()

    // Two nodes, one attachment on the wire.
    expect(extractUploadedAttachments(editor.getJSON() as JSONContent)).toEqual([
      { id: "att_1", filename: "screenshot.png", mimeType: "image/png", sizeBytes: 2048 },
    ])
  })

  it("never deletes from the document — a tray drag is an insert, not a move", () => {
    const editor = createEditor([
      { type: "text", text: "hello world" },
      { type: "mention", attrs: { id: "usr_1", slug: "alice", mentionType: "user" } },
    ])
    vi.spyOn(editor.view, "posAtCoords").mockReturnValue({ pos: 1, inside: -1 })
    renderTray(editor, [attachment()])

    dragChipIntoEditor(screen.getByText("screenshot.png"))

    expect(childTypes(editor)).toEqual(["attachmentReference", "text", "mention"])
    expect(editor.view.dom.querySelector(".composer-pill-dragging")).toBeNull()
    expect(editor.view.dom.querySelector(".composer-pill-drop-cursor")).toBeNull()
  })

  it("counts references from the document and follows an added or removed one", () => {
    const editor = createEditor()
    vi.spyOn(editor.view, "posAtCoords").mockReturnValue({ pos: 1, inside: -1 })
    const { rerender } = render(
      <ComposerPillDndProvider editor={editor}>
        <PendingAttachments
          attachments={[attachment()]}
          onRemove={vi.fn()}
          workspaceId="ws_1"
          referenceCounts={countAttachmentReferences(editor.getJSON() as JSONContent)}
        />
      </ComposerPillDndProvider>
    )
    expect(screen.queryByLabelText("2 references in this message")).toBeNull()

    dragChipIntoEditor(screen.getByText("screenshot.png"))
    dragChipIntoEditor(screen.getByText("screenshot.png"))
    const twice = countAttachmentReferences(editor.getJSON() as JSONContent)
    expect(twice.get("att_1")).toBe(2)

    const tray = (counts: ReadonlyMap<string, number>) => (
      <ComposerPillDndProvider editor={editor}>
        <PendingAttachments
          attachments={[attachment()]}
          onRemove={vi.fn()}
          workspaceId="ws_1"
          referenceCounts={counts}
        />
      </ComposerPillDndProvider>
    )
    rerender(tray(twice))
    expect(screen.getByLabelText("2 references in this message")).toHaveTextContent("×2")

    editor.commands.removeAttachmentReferences("att_1")
    rerender(tray(countAttachmentReferences(editor.getJSON() as JSONContent)))
    expect(screen.queryByLabelText("2 references in this message")).toBeNull()
  })

  it("renders one scrolling row on mobile and the wrapping tray on desktop", () => {
    const desktop = render(<PendingAttachments attachments={[attachment()]} onRemove={vi.fn()} workspaceId="ws_1" />)
    expect(desktop.container.querySelector("div")).toHaveClass("flex-wrap")
    desktop.unmount()

    vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(true)
    const mobile = render(<PendingAttachments attachments={[attachment()]} onRemove={vi.fn()} workspaceId="ws_1" />)
    const row = mobile.container.querySelector("div")!
    expect(row).toHaveClass("overflow-x-auto")
    expect(row).not.toHaveClass("flex-wrap")
  })
})

describe("drag preview", () => {
  it("shows a preview naming the dragged attachment while a tray drag is in flight", () => {
    const editor = createEditor()
    vi.spyOn(editor.view, "posAtCoords").mockReturnValue({ pos: 1, inside: -1 })
    renderTray(editor, [attachment()])

    const chip = screen.getByText("screenshot.png")
    expect(screen.queryByTestId("composer-pill-drag-preview")).toBeNull()

    fireEvent.mouseDown(chip, { button: 0, clientX: 10, clientY: 10 })
    fireEvent.mouseMove(document, { buttons: 1, clientX: 30, clientY: 10 })
    const preview = screen.getByTestId("composer-pill-drag-preview")
    expect(preview).toHaveTextContent("screenshot.png")
    expect(preview).toHaveTextContent("2.0 KB")

    fireEvent.mouseUp(document, { button: 0, clientX: 30, clientY: 10 })
    expect(screen.queryByTestId("composer-pill-drag-preview")).toBeNull()
  })

  it("shows no preview for an in-document pill drag — it is dimmed in place instead", () => {
    const editor = createEditor([
      { type: "text", text: "hello world" },
      { type: "mention", attrs: { id: "usr_1", slug: "alice", mentionType: "user" } },
    ])
    vi.spyOn(editor.view, "posAtCoords").mockReturnValue({ pos: 1, inside: -1 })
    renderTray(editor, [attachment()])

    const pill = editor.view.dom.querySelector<HTMLElement>('[data-type="mention"]')!
    fireEvent.mouseDown(pill, { button: 0, clientX: 10, clientY: 10 })
    fireEvent.mouseMove(document, { buttons: 1, clientX: 30, clientY: 10 })

    expect(editor.view.dom.querySelector(".composer-pill-dragging")).not.toBeNull()
    expect(screen.queryByTestId("composer-pill-drag-preview")).toBeNull()
    fireEvent.mouseUp(document, { button: 0, clientX: 30, clientY: 10 })
  })
})

describe("chip click after a drag", () => {
  it("still reaches the chip's activate handler", () => {
    const editor = createEditor()
    vi.spyOn(editor.view, "posAtCoords").mockReturnValue({ pos: 1, inside: -1 })
    const notes = attachment({
      id: "att_2",
      filename: "notes.txt",
      mimeType: "text/plain",
      previewUrl: "blob:preview-2",
    })
    renderTray(editor, [attachment(), notes])

    dragChipIntoEditor(screen.getByText("screenshot.png"))
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()

    const other = screen.getByRole("button", { name: "Preview notes.txt" })
    fireEvent.mouseDown(other, { button: 0, clientX: 5, clientY: 5 })
    fireEvent.mouseUp(other, { button: 0, clientX: 5, clientY: 5 })
    fireEvent.click(other)

    expect(screen.getByRole("dialog")).toBeInTheDocument()
  })
})

describe("referenced chip leading slot", () => {
  it("keeps the error glyph on a referenced attachment that failed to upload", () => {
    const failed = attachment({
      status: "error",
      error: "Upload failed",
      filename: "notes.txt",
      mimeType: "text/plain",
      previewUrl: undefined,
    })
    const { container } = render(
      <PendingAttachments
        attachments={[failed]}
        onRemove={vi.fn()}
        workspaceId="ws_1"
        referenceCounts={new Map([["att_1", 1]])}
      />
    )

    const leading = container.querySelector("svg")!
    expect(leading).toHaveClass("lucide-circle-alert")
    expect(container.querySelector(".lucide-anchor")).toBeNull()
  })

  it("keeps the spinner on a referenced attachment that is still uploading", () => {
    const uploading = attachment({
      status: "uploading",
      progress: 0.4,
      filename: "notes.txt",
      mimeType: "text/plain",
      previewUrl: undefined,
    })
    const { container } = render(
      <PendingAttachments
        attachments={[uploading]}
        onRemove={vi.fn()}
        workspaceId="ws_1"
        referenceCounts={new Map([["att_1", 1]])}
      />
    )

    expect(container.querySelector("svg")).toHaveClass("lucide-loader-circle")
    expect(container.querySelector(".lucide-anchor")).toBeNull()
  })

  it("keeps the thumbnail on a referenced image chip", () => {
    const { container } = render(
      <PendingAttachments
        attachments={[attachment()]}
        onRemove={vi.fn()}
        workspaceId="ws_1"
        referenceCounts={new Map([["att_1", 1]])}
      />
    )

    expect(container.querySelector('img[src="blob:preview-1"]')).toBeTruthy()
    expect(container.querySelector(".lucide-anchor")).toBeNull()
  })

  it("exposes the ×N count with an accessible name, and never at one reference", () => {
    const doc = attachment({ id: "att_2", filename: "notes.txt", mimeType: "text/plain", previewUrl: undefined })
    const once = render(
      <PendingAttachments
        attachments={[doc]}
        onRemove={vi.fn()}
        workspaceId="ws_1"
        referenceCounts={new Map([["att_2", 1]])}
      />
    )
    expect(screen.queryByText("×1")).toBeNull()
    once.unmount()

    render(
      <PendingAttachments
        attachments={[doc]}
        onRemove={vi.fn()}
        workspaceId="ws_1"
        referenceCounts={new Map([["att_2", 2]])}
      />
    )
    expect(screen.getByRole("img", { name: "2 references in this message" })).toHaveTextContent("×2")
  })

  it("shows the anchor on a referenced chip with no thumbnail of its own", () => {
    const doc = attachment({ id: "att_2", filename: "notes.txt", mimeType: "text/plain", previewUrl: undefined })
    const { container } = render(
      <PendingAttachments
        attachments={[doc]}
        onRemove={vi.fn()}
        workspaceId="ws_1"
        referenceCounts={new Map([["att_2", 1]])}
      />
    )

    expect(container.querySelector(".lucide-anchor")).toBeTruthy()
  })
})

describe("tray-dragged image ordinal", () => {
  it("stamps the ordinal send would give it, so both references read the same", () => {
    const editor = createEditor()
    vi.spyOn(editor.view, "posAtCoords").mockReturnValue({ pos: 1, inside: -1 })
    const first = attachment({ id: "att_1", filename: "first.png", previewUrl: "blob:preview-1" })
    const second = attachment({ id: "att_2", filename: "second.png", previewUrl: "blob:preview-2" })
    renderTray(editor, [first, second])

    dragChipIntoEditor(screen.getByText("second.png"))

    const inserted = (editor.getJSON() as JSONContent).content?.[0]?.content?.[0]
    expect(inserted?.attrs?.imageIndex).toBe(2)

    // The same attachment pasted as a pill and materialized at send resolves to
    // the same ordinal — one image, one label.
    const materialized = materializePendingAttachmentReferences(editor.getJSON() as JSONContent, [first, second])
    expect(materialized.content?.[0]?.content?.[0]?.attrs?.imageIndex).toBe(2)
  })

  it("skips failed and still-reserving attachments when numbering, as send does", () => {
    const editor = createEditor()
    vi.spyOn(editor.view, "posAtCoords").mockReturnValue({ pos: 1, inside: -1 })
    const attachments = [
      attachment({ id: "temp_1", filename: "reserving.png", previewUrl: "blob:preview-0" }),
      attachment({ id: "att_1", filename: "failed.png", status: "error", previewUrl: "blob:preview-1" }),
      attachment({ id: "att_2", filename: "sent.png", previewUrl: "blob:preview-2" }),
    ]
    renderTray(editor, attachments)

    dragChipIntoEditor(screen.getByText("sent.png"))

    expect((editor.getJSON() as JSONContent).content?.[0]?.content?.[0]?.attrs?.imageIndex).toBe(1)
  })
})

describe("attachment delete cascade", () => {
  it("removes every reference to the deleted attachment and leaves the others", () => {
    const editor = createEditor()
    vi.spyOn(editor.view, "posAtCoords").mockReturnValue({ pos: 1, inside: -1 })
    renderTray(editor, [attachment(), attachment({ id: "att_2", filename: "notes.txt", mimeType: "text/plain" })])

    dragChipIntoEditor(screen.getByText("screenshot.png"))
    dragChipIntoEditor(screen.getByText("screenshot.png"))
    dragChipIntoEditor(screen.getByText("notes.txt"))
    expect(countAttachmentReferences(editor.getJSON() as JSONContent)).toEqual(
      new Map([
        ["att_1", 2],
        ["att_2", 1],
      ])
    )

    expect(editor.commands.removeAttachmentReferences("att_1")).toBe(true)
    expect(countAttachmentReferences(editor.getJSON() as JSONContent)).toEqual(new Map([["att_2", 1]]))
    expect(editor.commands.removeAttachmentReferences("att_1")).toBe(false)
  })

  it("cascades across the temp→server id flip", () => {
    const editor = createEditor([])
    editor.commands.insertAttachmentReferences([
      {
        id: "temp_1",
        filename: "screenshot.png",
        mimeType: "image/png",
        sizeBytes: 2048,
        status: "uploading",
        imageIndex: null,
        error: null,
      },
    ])
    editor.commands.updateAttachmentReference("temp_1", { id: "att_1", status: "uploaded" })
    expect(countAttachmentReferences(editor.getJSON() as JSONContent).get("att_1")).toBe(1)

    // The chip's id flipped with the node's, so the delete the tray issues carries
    // the server id and still finds the reference it created under a temp one.
    expect(editor.commands.removeAttachmentReferences("att_1")).toBe(true)
    expect(countAttachmentReferences(editor.getJSON() as JSONContent).size).toBe(0)
  })
})

describe("send with an unreferenced attachment", () => {
  it("still appends it as a trailing paragraph", () => {
    const content: JSONContent = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
    }
    const materialized = materializePendingAttachmentReferences(content, [attachment()])

    expect(materialized.content?.[1]).toEqual({
      type: "paragraph",
      content: [
        {
          type: "attachmentReference",
          attrs: {
            id: "att_1",
            filename: "screenshot.png",
            mimeType: "image/png",
            sizeBytes: 2048,
            status: "uploaded",
            imageIndex: 1,
            error: null,
          },
        },
      ],
    })
  })

  it("materializes both references to one attachment without consuming it twice", () => {
    const reference: JSONContent = {
      type: "attachmentReference",
      attrs: {
        id: "att_1",
        filename: "screenshot.png",
        mimeType: "image/png",
        sizeBytes: 2048,
        status: "uploaded",
        imageIndex: null,
        error: null,
      },
    }
    const content: JSONContent = { type: "doc", content: [{ type: "paragraph", content: [reference, reference] }] }

    const materialized = materializePendingAttachmentReferences(content, [attachment()])

    expect(materialized.content).toHaveLength(1)
    expect(materialized.content?.[0]?.content?.map((node) => node.attrs?.imageIndex)).toEqual([1, 1])
  })
})
