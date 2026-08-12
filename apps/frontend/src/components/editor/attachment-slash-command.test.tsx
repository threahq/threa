import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createRef } from "react"
import { render, cleanup, fireEvent, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { Editor } from "@tiptap/react"
import { TextSelection } from "@tiptap/pm/state"
import type { JSONContent } from "@threa/types"
import { spyOnExport } from "@/test/spy"
import * as mentionablesModule from "@/hooks/use-mentionables"
import * as emojiModule from "@/hooks/use-workspace-emoji"
import * as giphyModule from "@/hooks/use-giphy-enabled"
import * as streamCommandsModule from "@/hooks/use-stream-commands"
import * as contextsModule from "@/contexts"
import type { PendingAttachment } from "@/hooks/use-attachments"
import { attachmentReferenceAttrs, insertAttachmentReferenceAt } from "./triggers/use-attachment-picker"
import { RichEditor, type RichEditorHandle } from "./rich-editor"
import { countAttachmentReferences } from "./attachment-reference-counts"

const TRAY: PendingAttachment[] = [
  { id: "att_photo", filename: "beach.png", mimeType: "image/png", sizeBytes: 10, status: "uploaded" },
  { id: "att_notes", filename: "notes.txt", mimeType: "text/plain", sizeBytes: 20, status: "uploaded" },
  { id: "att_second", filename: "sunset.png", mimeType: "image/png", sizeBytes: 30, status: "uploaded" },
]

// Stable across renders: RichEditor re-derives its content from these, and a
// fresh object each render would re-apply the (empty) external value mid-test.
const NO_MENTIONABLES = { mentionables: [], isLoading: false }
const NO_EMOJI = { emojis: [], emojiWeights: {}, toEmoji: () => null, toShortcode: () => null }
const NO_PREFERENCES = { preferences: {} }

beforeEach(() => {
  spyOnExport(mentionablesModule, "useMentionables").mockReturnValue((() => NO_MENTIONABLES) as never)
  spyOnExport(emojiModule, "useWorkspaceEmoji").mockReturnValue((() => NO_EMOJI) as never)
  spyOnExport(giphyModule, "useGiphyEnabled").mockReturnValue((() => false) as never)
  spyOnExport(streamCommandsModule, "useStreamCommands").mockReturnValue((() => []) as never)
  spyOnExport(contextsModule, "usePreferences").mockReturnValue((() => NO_PREFERENCES) as never)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

interface Harness {
  handle: RichEditorHandle
  editor: Editor
  getContent: () => JSONContent
  onRequestFileUpload: ReturnType<typeof vi.fn>
  uploads: File[]
}

function mountEditor(options: { trayAttachments?: PendingAttachment[]; autoFocus?: boolean } = {}): Harness {
  const ref = createRef<RichEditorHandle>()
  const onRequestFileUpload = vi.fn()
  const uploads: File[] = []
  let content: JSONContent = { type: "doc", content: [{ type: "paragraph" }] }

  function Host() {
    return (
      <RichEditor
        ref={ref}
        value={content}
        onChange={(json) => {
          content = json
        }}
        onSubmit={() => undefined}
        onFileUpload={async (file) => {
          uploads.push(file)
          return {
            attachment: {
              id: "att_uploaded",
              filename: file.name,
              mimeType: file.type,
              sizeBytes: file.size,
              status: "uploaded" as const,
            },
            tempId: "temp_1",
            imageIndex: 7,
          }
        }}
        ariaLabel="Message input"
        autoFocus={options.autoFocus ?? true}
        trayAttachments={options.trayAttachments ?? TRAY}
        onRequestFileUpload={onRequestFileUpload}
      />
    )
  }

  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/w/ws_1/s/stream_1"]}>
        <Routes>
          <Route path="/w/:workspaceId/s/:streamId" element={<Host />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )

  const handle = ref.current!
  const editor = handle.getEditor()!
  return { handle, editor, getContent: () => editor.getJSON(), onRequestFileUpload, uploads }
}

function typeText(editor: Editor, text: string) {
  editor.commands.focus()
  for (const char of text) editor.view.dispatch(editor.state.tr.insertText(char))
}

function pressKey(editor: Editor, key: string) {
  fireEvent.keyDown(editor.view.dom, { key })
}

function attachmentNodes(doc: JSONContent): JSONContent[] {
  const found: JSONContent[] = []
  const walk = (node: JSONContent) => {
    if (node.type === "attachmentReference") found.push(node)
    node.content?.forEach(walk)
  }
  walk(doc)
  return found
}

/** Type the command and pick it from the slash palette, keyboard only. */
async function openPicker(editor: Editor, prefix = "") {
  if (prefix) typeText(editor, prefix)
  typeText(editor, "/attachment")
  await screen.findByRole("option", { name: /\/attachment/ })
  pressKey(editor, "Enter")
  await screen.findByRole("listbox", { name: "Attachment suggestions" })
}

/** Paragraph child node types, in order — distinguishes caret-insert from append. */
function paragraphChildTypes(doc: JSONContent): (string | undefined)[] {
  const paragraph = doc.content?.[0]
  return (paragraph?.content ?? []).map((node) => node.type)
}

describe("/attachment slash command", () => {
  it("surfaces the command at message start and mid-sentence", async () => {
    const { editor } = mountEditor()
    typeText(editor, "/attach")
    expect(await screen.findByRole("option", { name: /\/attachment/ })).toBeTruthy()

    editor.commands.setContent({ type: "doc", content: [{ type: "paragraph" }] })
    typeText(editor, "see this /attach")
    expect(await screen.findByRole("option", { name: /\/attachment/ })).toBeTruthy()
  })

  it("inserts one reference at the caret with the tray attachment's attrs", async () => {
    const { editor, getContent } = mountEditor()
    await openPicker(editor, "look ")
    fireEvent.click(await screen.findByRole("option", { name: /notes\.txt/ }))

    await waitFor(() => expect(attachmentNodes(getContent())).toHaveLength(1))
    expect(attachmentNodes(getContent())[0]?.attrs).toEqual({
      id: "att_notes",
      filename: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 20,
      status: "uploaded",
      imageIndex: null,
      error: null,
    })
    expect(editor.state.doc.textContent).toBe("look ")
  })

  it("stamps the same image ordinal a tray drag of that attachment would", async () => {
    const { editor, getContent } = mountEditor()
    await openPicker(editor)
    fireEvent.click(await screen.findByRole("option", { name: /sunset\.png/ }))

    // sunset.png is the second image among the materializable attachments.
    await waitFor(() => expect(attachmentNodes(getContent())[0]?.attrs?.imageIndex).toBe(2))
  })

  it("narrows the list by filename as the filter is typed", async () => {
    const { editor } = mountEditor()
    await openPicker(editor)
    typeText(editor, "sun")
    await waitFor(() => {
      const labels = screen.getAllByRole("option").map((option) => option.textContent ?? "")
      expect(labels.some((label) => label.includes("sunset.png"))).toBe(true)
      expect(labels.some((label) => label.includes("notes.txt"))).toBe(false)
    })
  })

  it("selects with the keyboard alone and lands the node at the caret", async () => {
    const { editor, getContent } = mountEditor()
    await openPicker(editor, "before ")
    typeText(editor, "notes")
    await waitFor(() => expect(screen.getAllByRole("option")[0]?.textContent).toContain("notes.txt"))
    pressKey(editor, "Enter")

    await waitFor(() => expect(attachmentNodes(getContent())).toHaveLength(1))
    expect(attachmentNodes(getContent())[0]?.attrs?.id).toBe("att_notes")
    expect(editor.state.doc.textContent).toBe("before ")
  })

  // `autoFocus` is off here only because the harness's autofocus("end") drags the
  // caret to the doc end a tick after typing, which no browser does.
  it("lands the node at a mid-paragraph caret, not at the end of the paragraph", async () => {
    const { editor, getContent } = mountEditor({ autoFocus: false })
    typeText(editor, "alpha beta")
    // Caret between "alpha " and "beta" — position 7 in a single paragraph.
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 7)))
    for (const char of "/attachment") editor.view.dispatch(editor.state.tr.insertText(char))
    await screen.findByRole("option", { name: /\/attachment/ })
    pressKey(editor, "Enter")
    await screen.findByRole("listbox", { name: "Attachment suggestions" })

    fireEvent.click(await screen.findByRole("option", { name: /notes\.txt/ }))

    await waitFor(() => expect(attachmentNodes(getContent())).toHaveLength(1))
    expect(paragraphChildTypes(getContent())).toEqual(["text", "attachmentReference", "text"])
    expect(editor.state.doc.textContent).toBe("alpha beta")
  })

  it("inserts at the anchor the picker captured, directly through the insert helper", () => {
    const { editor, getContent } = mountEditor()
    typeText(editor, "alpha beta")
    insertAttachmentReferenceAt(editor, attachmentReferenceAttrs(TRAY[1]!, null), 7)
    expect(paragraphChildTypes(getContent())).toEqual(["text", "attachmentReference", "text"])
  })

  it("raises the tray chip's reference count for the picked attachment", async () => {
    const { editor, getContent } = mountEditor()
    expect(countAttachmentReferences(getContent()).get("att_notes")).toBeUndefined()
    await openPicker(editor)
    fireEvent.click(await screen.findByRole("option", { name: /notes\.txt/ }))

    await waitFor(() => expect(countAttachmentReferences(getContent()).get("att_notes")).toBe(1))
  })

  it("uploads and inserts in one flow when 'Upload a file…' is chosen", async () => {
    const harness = mountEditor()
    const { editor, getContent, onRequestFileUpload } = harness
    await openPicker(editor, "here ")
    fireEvent.click(await screen.findByRole("option", { name: /Upload a file/ }))
    expect(onRequestFileUpload).toHaveBeenCalledTimes(1)

    // What the composer's file input does with the picked file.
    harness.handle.insertFiles([new File(["x"], "picked.png", { type: "image/png" })])

    await waitFor(() => expect(attachmentNodes(getContent())[0]?.attrs?.id).toBe("att_uploaded"))
    expect(harness.uploads.map((file) => file.name)).toEqual(["picked.png"])
    expect(attachmentNodes(getContent())[0]?.attrs?.imageIndex).toBe(7)
    expect(editor.state.doc.textContent.startsWith("here ")).toBe(true)
  })
})
