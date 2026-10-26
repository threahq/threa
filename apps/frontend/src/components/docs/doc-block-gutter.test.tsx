import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { EditorContent, useEditor, type Editor } from "@tiptap/react"
import type { JSONContent } from "@tiptap/core"
import * as Y from "yjs"
import { prosemirrorJSONToYDoc } from "y-prosemirror"
import { DOC_FRAGMENT } from "@threahq/types"
import { getThreaSchema } from "@threahq/prosemirror/schema"
import { createDocumentExtensions } from "@/components/editor/editor-extensions"
import * as contextsModule from "@/contexts"
import { DocBlockGutter } from "./doc-block-gutter"
import type { DocBlockThreads } from "./use-doc-block-threads"

const DOC_ID = "stream_doc"
const FIRST_ID = `blk_${"0".repeat(25)}1`
const SECOND_ID = `blk_${"0".repeat(25)}2`

const content: JSONContent = {
  type: "doc",
  content: [
    { type: "paragraph", attrs: { blockId: FIRST_ID }, content: [{ type: "text", text: "First block" }] },
    { type: "paragraph", attrs: { blockId: SECOND_ID }, content: [{ type: "text", text: "Second block" }] },
    { type: "paragraph", content: [{ type: "text", text: "Not yet stamped" }] },
  ],
}

let currentEditor: Editor | null = null

function Harness({ threads, canComment }: { threads: DocBlockThreads; canComment: boolean }) {
  const editor = useEditor({
    extensions: createDocumentExtensions({
      ydoc: prosemirrorJSONToYDoc(getThreaSchema(), content, DOC_FRAGMENT) as Y.Doc,
      awareness: null,
    }),
  })
  currentEditor = editor
  return (
    <div data-testid="column" className="relative">
      <EditorContent editor={editor} />
      <DocBlockGutter editor={editor} docId={DOC_ID} threads={threads} canComment={canComment} />
    </div>
  )
}

/** Lays the blocks out 30px apart, 20px tall, as the browser would, then lets the gutter re-measure. */
function layOutBlocks() {
  const editor = currentEditor!
  editor.state.doc.forEach((_node, offset, index) => {
    const dom = editor.view.nodeDOM(offset) as HTMLElement
    const top = index * 30
    dom.getBoundingClientRect = () => ({ top, bottom: top + 20, height: 20 }) as DOMRect
  })
  act(() => {
    window.dispatchEvent(new Event("resize"))
  })
}

function hrefs(name: string | RegExp): string[] {
  return screen.queryAllByRole("link", { name }).map((link) => link.getAttribute("href") ?? "")
}

describe("DocBlockGutter", () => {
  beforeEach(() => {
    vi.spyOn(contextsModule, "usePanel").mockReturnValue({
      getPanelUrl: (panelId: string) => `/w/ws_1?panel=${encodeURIComponent(panelId)}`,
    } as unknown as ReturnType<typeof contextsModule.usePanel>)
  })

  afterEach(() => {
    cleanup()
    currentEditor = null
    vi.restoreAllMocks()
  })

  async function mount(threads: DocBlockThreads, canComment = true) {
    render(
      <MemoryRouter>
        <Harness threads={threads} canComment={canComment} />
      </MemoryRouter>
    )
    await waitFor(() => expect(currentEditor?.state.doc.childCount).toBe(3))
    layOutBlocks()
  }

  const threadOnSecond: DocBlockThreads = new Map([[SECOND_ID, { threadId: "stream_thread", replyCount: 3 }]])

  it("should link the count chip of a block with a thread to that thread", async () => {
    await mount(threadOnSecond)

    expect({
      chips: hrefs(/comments? on this block/),
      comment: hrefs("Comment on this block"),
    }).toEqual({ chips: ["/w/ws_1?panel=stream_thread"], comment: [] })
    expect(screen.getByRole("link", { name: "3 comments on this block" })).toHaveTextContent("3")
  })

  it("should offer Comment on the hovered block, opening a draft thread anchored on it", async () => {
    await mount(threadOnSecond)

    fireEvent.mouseMove(screen.getByTestId("column"), { clientY: 10 })

    expect(hrefs("Comment on this block")).toEqual([
      `/w/ws_1?panel=${encodeURIComponent(`draft:${DOC_ID}:${FIRST_ID}`)}`,
    ])
  })

  it("should offer nothing on a block the server has not stamped yet", async () => {
    await mount(threadOnSecond)

    fireEvent.mouseMove(screen.getByTestId("column"), { clientY: 70 })

    expect(hrefs("Comment on this block")).toEqual([])
  })

  it("should offer Comment on the block holding the caret", async () => {
    await mount(new Map())

    fireEvent.focus(currentEditor!.view.dom)
    act(() => {
      currentEditor!.commands.setTextSelection(3)
    })

    expect(hrefs("Comment on this block")).toEqual([
      `/w/ws_1?panel=${encodeURIComponent(`draft:${DOC_ID}:${FIRST_ID}`)}`,
    ])
  })

  it("should keep the count chip but hide Comment from a viewer who cannot comment", async () => {
    await mount(threadOnSecond, false)

    fireEvent.mouseMove(screen.getByTestId("column"), { clientY: 10 })

    expect({
      chips: hrefs(/comments? on this block/),
      comment: hrefs("Comment on this block"),
    }).toEqual({ chips: ["/w/ws_1?panel=stream_thread"], comment: [] })
  })
})
