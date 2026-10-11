import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createRef } from "react"
import { act, render, cleanup, fireEvent, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { Editor } from "@tiptap/react"
import type { JSONContent } from "@threahq/types"
import { spyOnExport } from "@/test/spy"
import * as mentionablesModule from "@/hooks/use-mentionables"
import * as emojiModule from "@/hooks/use-workspace-emoji"
import * as giphyModule from "@/hooks/use-giphy-enabled"
import * as streamCommandsModule from "@/hooks/use-stream-commands"
import * as contextsModule from "@/contexts"
import { RichEditor, type RichEditorHandle } from "./rich-editor"

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

function mountEditor(): { handle: RichEditorHandle; editor: Editor; steps: number[] } {
  const ref = createRef<RichEditorHandle>()
  const steps: number[] = []
  let content: JSONContent = { type: "doc", content: [{ type: "paragraph" }] }

  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/w/ws_1/s/stream_1"]}>
        <Routes>
          <Route
            path="/w/:workspaceId/s/:streamId"
            element={
              <RichEditor
                ref={ref}
                value={content}
                onChange={(json) => {
                  content = json
                }}
                onSubmit={() => undefined}
                onFileUpload={async (file) => ({
                  attachment: {
                    id: "att_uploaded",
                    filename: file.name,
                    mimeType: file.type,
                    sizeBytes: file.size,
                    status: "uploaded" as const,
                  },
                  tempId: "temp_1",
                  imageIndex: null,
                })}
                onRequestFileUpload={() => undefined}
                onHistoryStep={(delta) => steps.push(delta)}
                ariaLabel="Message input"
                autoFocus
              />
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )

  const handle = ref.current!
  return { handle, editor: handle.getEditor()!, steps }
}

function typeText(editor: Editor, text: string) {
  editor.commands.focus()
  act(() => {
    for (const char of text) editor.view.dispatch(editor.state.tr.insertText(char))
  })
}

/** ⌘← then ⌘→; returns whether the editor claimed each key. */
function pressHistoryKeys(editor: Editor): boolean[] {
  return ["ArrowLeft", "ArrowRight"].map((key) => !fireEvent.keyDown(editor.view.dom, { key, metaKey: true }))
}

describe("RichEditor history keys", () => {
  it("steps history on ⌘←/⌘→ while nothing is typed", () => {
    const { editor, steps } = mountEditor()

    expect({ claimed: pressHistoryKeys(editor), steps }).toEqual({ claimed: [true, true], steps: [-1, 1] })
  })

  it("still steps history when the only content is an attachment", () => {
    const { handle, editor, steps } = mountEditor()
    act(() => {
      handle.insertFiles([new File(["x"], "notes.txt", { type: "text/plain" })])
    })
    // The reference arrives with its separator space, which is not typed text.
    expect(editor.getJSON().content?.[0]?.content?.map((node) => node.type)).toEqual(["attachmentReference", "text"])

    expect({ claimed: pressHistoryKeys(editor), steps }).toEqual({ claimed: [true, true], steps: [-1, 1] })
  })

  it.each([
    ["text", "hello"],
    ["whitespace alone", " "],
    ["text beside an attachment", "attachment+text"],
  ])("leaves the keys to the caret with %s", (_label, typed) => {
    const { handle, editor, steps } = mountEditor()
    if (typed === "attachment+text") {
      act(() => {
        handle.insertFiles([new File(["x"], "notes.txt", { type: "text/plain" })])
      })
      typeText(editor, "hello")
    } else {
      typeText(editor, typed)
    }

    expect({ claimed: pressHistoryKeys(editor), steps }).toEqual({ claimed: [false, false], steps: [] })
  })

  it("leaves an empty second line to the caret", () => {
    const { editor, steps } = mountEditor()
    act(() => {
      editor.commands.setContent({ type: "doc", content: [{ type: "paragraph" }, { type: "paragraph" }] })
    })

    expect({ claimed: pressHistoryKeys(editor), steps }).toEqual({ claimed: [false, false], steps: [] })
  })

  it("ignores the arrows under any other modifier", () => {
    const { editor, steps } = mountEditor()
    const combos = [
      { ctrlKey: true },
      { altKey: true },
      { metaKey: true, shiftKey: true },
      { metaKey: true, ctrlKey: true },
      { metaKey: true, altKey: true },
      {},
    ]
    for (const modifiers of combos) {
      fireEvent.keyDown(editor.view.dom, { key: "ArrowLeft", ...modifiers })
    }

    expect(steps).toEqual([])
  })

  it("steps once for a held key", () => {
    const { editor, steps } = mountEditor()
    fireEvent.keyDown(editor.view.dom, { key: "ArrowLeft", metaKey: true })
    fireEvent.keyDown(editor.view.dom, { key: "ArrowLeft", metaKey: true, repeat: true })

    expect(steps).toEqual([-1])
  })

  it("leaves the keys alone while the attachment picker is open", async () => {
    const { editor, steps } = mountEditor()
    typeText(editor, "/attachment")
    await screen.findByRole("option", { name: /\/attachment/ })
    fireEvent.keyDown(editor.view.dom, { key: "Enter" })
    await screen.findByRole("listbox", { name: "Attachment suggestions" })
    // The command text is gone: only the open picker holds the keys back.
    expect(editor.state.doc.textContent).toBe("")

    expect({ claimed: pressHistoryKeys(editor), steps }).toEqual({ claimed: [false, false], steps: [] })
  })
})
