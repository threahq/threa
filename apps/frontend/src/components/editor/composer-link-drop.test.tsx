import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createRef } from "react"
import { render, cleanup, fireEvent } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { JSONContent } from "@threahq/types"
import { spyOnExport } from "@/test/spy"
import * as mentionablesModule from "@/hooks/use-mentionables"
import * as emojiModule from "@/hooks/use-workspace-emoji"
import * as giphyModule from "@/hooks/use-giphy-enabled"
import * as streamCommandsModule from "@/hooks/use-stream-commands"
import * as contextsModule from "@/contexts"
import * as currentUserModule from "@/hooks/use-current-workspace-user-id"
import { RichEditor, readDroppedUrl, type RichEditorHandle } from "./rich-editor"

const NO_MENTIONABLES = { mentionables: [], isLoading: false }
const NO_EMOJI = { emojis: [], emojiWeights: {}, toEmoji: () => null, toShortcode: () => null }
const NO_PREFERENCES = { preferences: {} }

beforeEach(() => {
  spyOnExport(mentionablesModule, "useMentionables").mockReturnValue((() => NO_MENTIONABLES) as never)
  spyOnExport(emojiModule, "useWorkspaceEmoji").mockReturnValue((() => NO_EMOJI) as never)
  spyOnExport(giphyModule, "useGiphyEnabled").mockReturnValue((() => false) as never)
  spyOnExport(streamCommandsModule, "useStreamCommands").mockReturnValue((() => []) as never)
  spyOnExport(contextsModule, "usePreferences").mockReturnValue((() => NO_PREFERENCES) as never)
  // The chip's node view reads the viewer off the auth context, which this
  // harness doesn't mount.
  spyOnExport(currentUserModule, "useCurrentWorkspaceUserId").mockReturnValue((() => null) as never)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** jsdom ships no DataTransfer, so stand one up over a plain map. */
function stubDataTransfer(entries: Record<string, string>) {
  const store = new Map(Object.entries(entries))
  return {
    dropEffect: "none",
    effectAllowed: "none",
    files: [] as unknown as FileList,
    get types() {
      return [...store.keys()]
    },
    setData: (type: string, value: string) => void store.set(type, value),
    getData: (type: string) => store.get(type) ?? "",
  }
}

function mountEditor(initial?: JSONContent) {
  const ref = createRef<RichEditorHandle>()
  let content: JSONContent = initial ?? { type: "doc", content: [{ type: "paragraph" }] }

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
                ariaLabel="Message input"
                autoFocus
              />
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )

  const editor = ref.current!.getEditor()!
  // jsdom has no layout, so ProseMirror's drop handler bails before it can call
  // `handleDrop` unless the drop point resolves. Land every drop in the (empty)
  // paragraph unless the test aims somewhere else.
  const dropAt = (pos: number) => {
    editor.view.posAtCoords = () => ({ pos, inside: -1 })
  }
  dropAt(1)
  return { editor, dropAt, getContent: () => editor.getJSON() }
}

function inAppLinkNodes(doc: JSONContent): JSONContent[] {
  const found: JSONContent[] = []
  const walk = (node: JSONContent) => {
    if (node.type === "inAppLink") found.push(node)
    node.content?.forEach(walk)
  }
  walk(doc)
  return found
}

describe("readDroppedUrl", () => {
  it("takes the first real entry of an RFC 2483 uri-list, skipping comments", () => {
    const data = stubDataTransfer({ "text/uri-list": "# a comment\r\nhttps://app.threa.io/w/ws_1/s/stream_1\r\n" })
    expect(readDroppedUrl(data as unknown as DataTransfer)).toBe("https://app.threa.io/w/ws_1/s/stream_1")
  })

  it("falls back to text/plain when the drop carries no uri-list", () => {
    const data = stubDataTransfer({ "text/plain": "https://app.threa.io/w/ws_1/s/stream_1" })
    expect(readDroppedUrl(data as unknown as DataTransfer)).toBe("https://app.threa.io/w/ws_1/s/stream_1")
  })

  it("refuses a dragged text selection that merely contains a link", () => {
    const selection = `${window.location.origin}/w/ws_1/s/stream_1 and a second line of notes`
    expect(readDroppedUrl(stubDataTransfer({ "text/plain": selection }) as unknown as DataTransfer)).toBeNull()
  })

  it("returns null for a drop with nothing textual on it", () => {
    expect(readDroppedUrl(stubDataTransfer({}) as unknown as DataTransfer)).toBeNull()
    expect(readDroppedUrl(null)).toBeNull()
  })
})

describe("dropping a link into the composer", () => {
  it("chips a dragged in-app stream link the same as a pasted one", () => {
    const { editor, getContent } = mountEditor()
    const url = `${window.location.origin}/w/ws_1/s/stream_1`

    fireEvent.drop(editor.view.dom, { dataTransfer: stubDataTransfer({ "text/uri-list": url }) })

    expect(inAppLinkNodes(getContent()).map((node) => node.attrs)).toEqual([
      { url, streamId: "stream_1", messageId: null, name: "" },
    ])
  })

  it("carries the message id when a permalink to a single message is dropped", () => {
    const { editor, getContent } = mountEditor()
    const url = `${window.location.origin}/w/ws_1/s/stream_1?m=msg_9`

    fireEvent.drop(editor.view.dom, { dataTransfer: stubDataTransfer({ "text/uri-list": url }) })

    expect(inAppLinkNodes(getContent()).map((node) => node.attrs)).toEqual([
      { url, streamId: "stream_1", messageId: "msg_9", name: "" },
    ])
  })

  it("chips at the drop point, not wherever the caret happened to be", () => {
    const { editor, dropAt, getContent } = mountEditor({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "before after" }] }],
    })
    editor.commands.focus("end")
    // Between "before" and " after".
    dropAt(7)

    fireEvent.drop(editor.view.dom, {
      dataTransfer: stubDataTransfer({ "text/uri-list": `${window.location.origin}/w/ws_1/s/stream_1` }),
    })

    expect(getContent().content?.[0].content?.map((node) => node.type)).toEqual(["text", "inAppLink", "text"])
  })

  it("leaves a code block intact — a chip there would split it and strand the code", () => {
    const { editor, dropAt, getContent } = mountEditor({
      type: "doc",
      content: [{ type: "codeBlock", content: [{ type: "text", text: "const a = 1" }] }],
    })
    dropAt(5)

    fireEvent.drop(editor.view.dom, {
      dataTransfer: stubDataTransfer({ "text/uri-list": `${window.location.origin}/w/ws_1/s/stream_1` }),
    })

    expect(inAppLinkNodes(getContent())).toEqual([])
    expect(getContent().content?.[0].type).toBe("codeBlock")
  })

  it("leaves an external link to ProseMirror's own drop handling", () => {
    const { editor, getContent } = mountEditor()

    fireEvent.drop(editor.view.dom, { dataTransfer: stubDataTransfer({ "text/uri-list": "https://example.com/docs" }) })

    expect(inAppLinkNodes(getContent())).toEqual([])
  })
})
