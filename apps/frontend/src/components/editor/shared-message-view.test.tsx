import { describe, it, expect, afterEach, vi } from "vitest"
import { cleanup, render, waitFor } from "@testing-library/react"
import { useEffect } from "react"
import { MemoryRouter } from "react-router-dom"
import type { Editor } from "@tiptap/core"
import { EditorContent, useEditor } from "@tiptap/react"
import Document from "@tiptap/extension-document"
import Paragraph from "@tiptap/extension-paragraph"
import Text from "@tiptap/extension-text"
import * as sourceModule from "@/hooks/use-shared-message-source"
import { spyOnExport } from "@/test"
import { SharedMessageExtension } from "./shared-message-extension"

function Harness({ attrs, onReady }: { attrs: Record<string, unknown>; onReady: (editor: Editor) => void }) {
  const editor = useEditor({
    extensions: [Document, Paragraph, Text, SharedMessageExtension],
    content: { type: "doc", content: [{ type: "sharedMessage", attrs }] },
  })
  useEffect(() => {
    if (editor) onReady(editor)
  }, [editor, onReady])
  return <EditorContent editor={editor} />
}

function mountShare(attrs: Record<string, unknown>): () => Editor | null {
  let editor: Editor | null = null
  render(
    <MemoryRouter>
      <Harness attrs={attrs} onReady={(ready) => (editor = ready)} />
    </MemoryRouter>
  )
  return () => editor
}

function shareAttrs(editor: Editor | null) {
  const { authorName, authorId, actorType } = editor?.getJSON().content?.[0]?.attrs ?? {}
  return { authorName, authorId, actorType }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("shared message node view", () => {
  function resolveAs(authorName: string | undefined) {
    spyOnExport(sourceModule, "useSharedMessageSource").mockReturnValue((() => ({
      status: "resolved",
      contentMarkdown: "hello",
      authorId: "usr_ada",
      actorType: "user",
      authorName,
      editedAt: null,
    })) as never)
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
})
