import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { Editor } from "@tiptap/core"
import type { JSONContent } from "@threa/types"
import { ComposerPillDndHost, ComposerPillDndProvider } from "@/components/editor/composer-pill-dnd"
import { countAttachmentReferences } from "@/components/editor/attachment-reference-counts"
import { createEditorExtensions } from "@/components/editor/editor-extensions"
import type { PendingAttachment } from "@/hooks/use-attachments"
import * as useMobileModule from "@/hooks/use-mobile"
import * as inputModeModule from "@/hooks/use-input-mode"
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

  it("drags uploading and failed chips too — a reference binds the id, not finished bytes", () => {
    const editor = createEditor()
    vi.spyOn(editor.view, "posAtCoords").mockReturnValue({ pos: 1, inside: -1 })
    renderTray(editor, [
      attachment({ id: "att_up", filename: "up.png", status: "uploading", progress: 0.4, previewUrl: "blob:up" }),
      attachment({
        id: "att_dead",
        filename: "dead.txt",
        mimeType: "text/plain",
        status: "error",
        error: "Network error during upload",
        previewUrl: undefined,
      }),
    ])

    dragChipIntoEditor(screen.getByText("up.png"))
    dragChipIntoEditor(screen.getByText("dead.txt"))

    const ids = (editor.getJSON() as JSONContent).content?.[0]?.content
      ?.filter((node) => node.type === "attachmentReference")
      .map((node) => node.attrs?.id)
    // Both drops land at the mocked pos 1, so the later drop sits first.
    expect(ids).toEqual(["att_dead", "att_up"])
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

  it("wraps the tray on both breakpoints, with the tighter height cap and the drawer tap on mobile", () => {
    const desktop = render(<PendingAttachments attachments={[attachment()]} onRemove={vi.fn()} workspaceId="ws_1" />)
    expect(desktop.container.querySelector(".flex-wrap")).toHaveClass("max-h-[120px]")
    // Desktop gets the same rollup summary, but as plain text — the wrapped
    // tray is its own full list, so there is no drawer behind a tap.
    expect(screen.getByText(/1 file/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Show all attachments" })).toBeNull()
    desktop.unmount()

    vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(true)
    const mobile = render(<PendingAttachments attachments={[attachment()]} onRemove={vi.fn()} workspaceId="ws_1" />)
    // A single horizontal row hid everything past the fold and fought the
    // page's own scroll axis — the tray wraps and scrolls vertically now.
    expect(mobile.container.querySelector(".overflow-x-auto")).toBeNull()
    const tray = screen.getByText("screenshot.png").closest(".flex-wrap")
    expect(tray).toHaveClass("max-h-[96px]", "overflow-y-auto")
    expect(screen.getByRole("button", { name: "Show all attachments" })).toHaveTextContent("1 file")
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

    expect(container.querySelector(".lucide-circle-alert")).toBeTruthy()
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

    expect(container.querySelector(".lucide-loader-circle")).toBeTruthy()
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

describe("referenced chip highlight", () => {
  const highlighted = (editor: Editor) =>
    [...editor.view.dom.querySelectorAll(".composer-pill-highlighted")].map((element) =>
      element.getAttribute("data-id")
    )

  /** Two references to att_1 and one to att_2, dropped in from the tray. */
  function trayWithReferences() {
    const editor = createEditor()
    vi.spyOn(editor.view, "posAtCoords").mockReturnValue({ pos: 1, inside: -1 })
    const notes = attachment({ id: "att_2", filename: "notes.txt", mimeType: "text/plain" })
    renderTray(editor, [attachment(), notes])
    dragChipIntoEditor(screen.getByText("screenshot.png"))
    dragChipIntoEditor(screen.getByText("screenshot.png"))
    dragChipIntoEditor(screen.getByText("notes.txt"))
    return editor
  }

  it("never dims a referenced chip", () => {
    render(
      <PendingAttachments
        attachments={[attachment()]}
        onRemove={vi.fn()}
        workspaceId="ws_1"
        referenceCounts={new Map([["att_1", 2]])}
      />
    )

    const chip = screen.getByRole("button", { name: "Preview screenshot.png" })
    expect(chip).not.toHaveClass("opacity-60")
    // The referenced state still reads: anchor is absent only because the image
    // thumbnail outranks it, so the count carries it here.
    expect(screen.getByRole("img", { name: "2 references in this message" })).toHaveTextContent("×2")
  })

  it("highlights only the dragged attachment's references, and clears them on drop", () => {
    const editor = trayWithReferences()
    expect(highlighted(editor)).toEqual([])

    const chip = screen.getByText("screenshot.png")
    fireEvent.mouseDown(chip, { button: 0, clientX: 10, clientY: 10 })
    fireEvent.mouseMove(document, { buttons: 1, clientX: 30, clientY: 10 })
    expect(highlighted(editor)).toEqual(["att_1", "att_1"])

    fireEvent.mouseUp(document, { button: 0, clientX: 30, clientY: 10 })
    expect(highlighted(editor)).toEqual([])
  })

  it("clears the highlight when the drag is cancelled with Escape", () => {
    const editor = trayWithReferences()

    fireEvent.mouseDown(screen.getByText("notes.txt"), { button: 0, clientX: 10, clientY: 10 })
    fireEvent.mouseMove(document, { buttons: 1, clientX: 30, clientY: 10 })
    expect(highlighted(editor)).toEqual(["att_2"])

    fireEvent.keyDown(document, { key: "Escape" })
    expect(highlighted(editor)).toEqual([])
  })

  it("highlights on hover with a mouse and not on touch", () => {
    vi.spyOn(inputModeModule, "useInputMode").mockReturnValue("mouse")
    const editor = trayWithReferences()

    const chip = screen.getByRole("button", { name: "Preview notes.txt" }).parentElement!
    fireEvent.mouseEnter(chip)
    expect(highlighted(editor)).toEqual(["att_2"])
    fireEvent.mouseLeave(chip)
    expect(highlighted(editor)).toEqual([])

    cleanup()
    vi.spyOn(inputModeModule, "useInputMode").mockReturnValue("touch")
    const touchEditor = trayWithReferences()
    fireEvent.mouseEnter(screen.getByRole("button", { name: "Preview notes.txt" }).parentElement!)
    expect(highlighted(touchEditor)).toEqual([])
  })
})

describe("a second editor inside the composer's drag host", () => {
  function composerTree(first: Editor | null, second: Editor | null) {
    return (
      <ComposerPillDndHost>
        <PendingAttachments attachments={[attachment()]} onRemove={vi.fn()} workspaceId="ws_1" />
        <ComposerPillDndProvider editor={first} />
        {second && <ComposerPillDndProvider editor={second} />}
      </ComposerPillDndHost>
    )
  }

  function renderComposerWith(first: Editor, second: Editor | null) {
    return render(composerTree(first, second))
  }

  it("leaves the tray drag working after the nested editor unmounts", () => {
    const first = createEditor()
    const second = createEditor()
    vi.spyOn(first.view, "posAtCoords").mockReturnValue({ pos: 1, inside: -1 })
    vi.spyOn(second.view, "posAtCoords").mockReturnValue({ pos: 1, inside: -1 })

    const { rerender } = renderComposerWith(first, second)
    rerender(composerTree(first, null))

    dragChipIntoEditor(screen.getByText("screenshot.png"))

    expect(childTypes(first)).toEqual(["attachmentReference", "text"])
  })

  it("gives the composer the host when its editor is built after the nested one", () => {
    const second = createEditor()
    vi.spyOn(second.view, "posAtCoords").mockReturnValue({ pos: 1, inside: -1 })

    const { rerender } = render(composerTree(null, second))
    const first = createEditor()
    vi.spyOn(first.view, "posAtCoords").mockReturnValue({ pos: 1, inside: -1 })
    rerender(composerTree(first, second))

    dragChipIntoEditor(screen.getByText("screenshot.png"))

    expect(childTypes(first)).toEqual(["attachmentReference", "text"])
    expect(childTypes(second)).toEqual(["text"])
  })

  it("keeps the nested editor's own drag off the composer's document", () => {
    const first = createEditor()
    const second = createEditor([
      { type: "text", text: "hello world" },
      { type: "mention", attrs: { id: "usr_1", slug: "alice", mentionType: "user" } },
    ])
    vi.spyOn(first.view, "posAtCoords").mockReturnValue({ pos: 1, inside: -1 })
    vi.spyOn(second.view, "posAtCoords").mockReturnValue({ pos: 1, inside: -1 })
    renderComposerWith(first, second)

    const pill = second.view.dom.querySelector<HTMLElement>('[data-type="mention"]')!
    fireEvent.mouseDown(pill, { button: 0, clientX: 10, clientY: 10 })
    fireEvent.mouseMove(document, { buttons: 1, clientX: 30, clientY: 10 })
    fireEvent.mouseUp(document, { button: 0, clientX: 30, clientY: 10 })

    expect(childTypes(second)).toEqual(["mention", "text"])
    expect(childTypes(first)).toEqual(["text"])

    // The tray still belongs to the composer's editor, not the newcomer's.
    dragChipIntoEditor(screen.getByText("screenshot.png"))
    expect(childTypes(first)).toEqual(["attachmentReference", "text"])
    expect(childTypes(second)).toEqual(["mention", "text"])
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
