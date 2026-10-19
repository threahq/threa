import { describe, it, expect, afterEach, vi } from "vitest"
import { cleanup, render, waitFor } from "@testing-library/react"
import { useEffect, useState } from "react"
import { MessageSquare } from "lucide-react"
import { MemoryRouter } from "react-router-dom"
import type { Editor, JSONContent } from "@tiptap/core"
import { EditorContent, useEditor } from "@tiptap/react"
import Document from "@tiptap/extension-document"
import Paragraph from "@tiptap/extension-paragraph"
import Text from "@tiptap/extension-text"
import History from "@tiptap/extension-history"
import * as sourceModule from "@/hooks/use-shared-message-source"
import * as chipModule from "@/hooks/use-in-app-link-chip"
import { buildMessageLink } from "@/lib/stream-links"
import { spyOnExport } from "@/test"
import { SharedMessageExtension } from "./shared-message-extension"
import { InAppLinkExtension } from "./in-app-link-extension"
import { linksToShares, sharesToLinks } from "./reference-conversions"

function Harness({ content, onReady }: { content: JSONContent[]; onReady: (editor: Editor) => void }) {
  const editor = useEditor({
    extensions: [Document, Paragraph, Text, History, InAppLinkExtension, SharedMessageExtension],
    content: { type: "doc", content },
  })
  useEffect(() => {
    if (editor) onReady(editor)
  }, [editor, onReady])
  return <EditorContent editor={editor} />
}

function mountEditor(content: JSONContent[]): () => Editor | null {
  let editor: Editor | null = null
  render(
    <MemoryRouter>
      <Harness content={content} onReady={(ready) => (editor = ready)} />
    </MemoryRouter>
  )
  return () => editor
}

const mountShare = (attrs: Record<string, unknown>) => mountEditor([{ type: "sharedMessage", attrs }])

function shareAttrs(editor: Editor | null) {
  const { authorName, authorId, actorType } = editor?.getJSON().content?.[0]?.attrs ?? {}
  return { authorName, authorId, actorType }
}

// Past History's 500ms grouping window, as a network resolve would be; sooner and the stamp would merge into the conversion.
const RESOLVE_LATER_MS = 600
const PAST_RESOLVE = { timeout: 3000 }

function useResolvedLater(): boolean {
  const [resolved, setResolved] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setResolved(true), RESOLVE_LATER_MS)
    return () => clearTimeout(timer)
  }, [])
  return resolved
}

function useChipResolvingLater(): ReturnType<typeof chipModule.useInAppLinkChip> {
  return useResolvedLater() ? { status: "resolved", label: "Src", icon: MessageSquare } : { status: "pending" }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("shared message node view", () => {
  const resolvedSource = (authorName: string | undefined) => ({
    status: "resolved",
    contentMarkdown: "hello",
    authorId: "usr_ada",
    actorType: "user",
    authorName,
    editedAt: null,
  })

  function resolveAs(authorName: string | undefined) {
    spyOnExport(sourceModule, "useSharedMessageSource").mockReturnValue((() => resolvedSource(authorName)) as never)
  }

  function resolveLaterAs(authorName: string) {
    spyOnExport(sourceModule, "useSharedMessageSource").mockReturnValue((() =>
      useResolvedLater() ? resolvedSource(authorName) : { status: "pending" }) as never)
  }

  it("stamps the resolved author onto a share that was inserted without one", async () => {
    resolveAs("Ada")
    const editor = mountShare({ streamId: "stream_src", messageId: "msg_1" })

    await waitFor(() =>
      expect(shareAttrs(editor())).toEqual({ authorName: "Ada", authorId: "usr_ada", actorType: "user" })
    )
  })

  it("keeps an author the share already carries", async () => {
    resolveAs("Ada Lovelace")
    const editor = mountShare({ streamId: "stream_src", messageId: "msg_1", authorName: "Ada", authorId: "usr_ada" })

    await waitFor(() => expect(editor()).not.toBeNull())
    expect(shareAttrs(editor())).toEqual({ authorName: "Ada", authorId: "usr_ada", actorType: "user" })
  })

  it("undoes a link-to-share conversion in one step after both shares are stamped", async () => {
    resolveLaterAs("Ada")
    spyOnExport(chipModule, "useInAppLinkChip").mockReturnValue(() => ({ status: "pending" }))
    const chip = (messageId: string): JSONContent => ({
      type: "inAppLink",
      attrs: { url: buildMessageLink("ws_1", "stream_src", messageId), streamId: "stream_src", messageId, name: "Src" },
    })
    const original: JSONContent[] = [
      { type: "paragraph", content: [chip("msg_1"), { type: "text", text: " and " }, chip("msg_2")] },
    ]
    const editor = mountEditor(original)
    await waitFor(() => expect(editor()).not.toBeNull())
    const ready = editor()!
    const before = ready.getJSON()

    linksToShares(ready, ["stream_src"])
    await waitFor(
      () =>
        expect(
          (ready.getJSON().content ?? [])
            .filter((node) => node.type === "sharedMessage")
            .map((node) => node.attrs?.authorName)
        ).toEqual(["Ada", "Ada"]),
      PAST_RESOLVE
    )
    ready.commands.undo()

    expect(ready.getJSON()).toEqual(before)
  })

  it("undoes a share-to-link conversion in one step after the link chip is named", async () => {
    resolveAs("Ada")
    spyOnExport(chipModule, "useInAppLinkChip").mockReturnValue(useChipResolvingLater)
    const editor = mountEditor([
      {
        type: "sharedMessage",
        attrs: { streamId: "stream_src", messageId: "msg_1", authorName: "Ada", authorId: "usr_ada" },
      },
    ])
    await waitFor(() => expect(editor()).not.toBeNull())
    const ready = editor()!
    const before = ready.getJSON()

    sharesToLinks(ready, "ws_1", ["stream_src"])
    await waitFor(() => {
      let name: unknown
      ready.state.doc.descendants((node) => {
        if (node.type.name === "inAppLink") name = node.attrs.name
      })
      expect(name).toBe("Src")
    }, PAST_RESOLVE)
    ready.commands.undo()

    expect(ready.getJSON()).toEqual(before)
  })
})
