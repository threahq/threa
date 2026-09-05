import { describe, it, expect, afterEach } from "vitest"
import { act, cleanup, render, screen } from "@testing-library/react"
import { useEffect } from "react"
import type { Editor } from "@tiptap/core"
import { EditorContent, useEditor } from "@tiptap/react"
import Document from "@tiptap/extension-document"
import Paragraph from "@tiptap/extension-paragraph"
import Text from "@tiptap/extension-text"
import { StreamTypes } from "@threa/types"
import { ChannelLinkProvider } from "@/lib/markdown/channel-link-context"
import { ChannelExtension } from "./channel-extension"

const STREAMS = [
  { id: "stream_pizza", type: StreamTypes.CHANNEL, slug: "pizza", displayName: null },
  { id: "stream_pi", type: StreamTypes.SCRATCHPAD, slug: null, displayName: "Pi remote control" },
]

function Harness({ attrs, onReady }: { attrs: { id: string; slug: string }; onReady?: (editor: Editor) => void }) {
  const editor = useEditor({
    extensions: [Document, Paragraph, Text, ChannelExtension],
    content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "channelLink", attrs }] }] },
  })
  useEffect(() => {
    if (editor) onReady?.(editor)
  }, [editor, onReady])
  return <EditorContent editor={editor} />
}

function mountChip(attrs: { id: string; slug: string }, onReady?: (editor: Editor) => void) {
  return render(
    <ChannelLinkProvider workspaceId="ws_1" streams={STREAMS}>
      <Harness attrs={attrs} onReady={onReady} />
    </ChannelLinkProvider>
  )
}

afterEach(cleanup)

describe("# chip in the composer", () => {
  it("names a scratchpad by its title, not the folded slug baked into the node", async () => {
    mountChip({ id: "stream_pi", slug: "pi-remote-control" })

    expect(await screen.findByText("Pi remote control")).toBeInTheDocument()
    expect(screen.queryByText("#pi-remote-control")).not.toBeInTheDocument()
  })

  it("keeps a channel in its sigil form", async () => {
    const { container } = mountChip({ id: "stream_pizza", slug: "pizza" })

    // `getText` renders `#pizza` too, so the text alone would pass with the node
    // view gone — the chip element is what proves it drew.
    expect(await screen.findByText("#pizza")).toBe(container.querySelector("[data-type='in-app-link-chip']"))
  })

  it("relabels from the id, so a rename reaches a draft that already holds the chip", async () => {
    mountChip({ id: "stream_pi", slug: "old-name" })

    expect(await screen.findByText("Pi remote control")).toBeInTheDocument()
  })

  it("falls back to the authored slug for a target with no cached row", async () => {
    const { container } = mountChip({ id: "stream_gone", slug: "ghost" })

    expect(await screen.findByText("#ghost")).toBe(container.querySelector("[data-type='in-app-link-chip']"))
  })

  // A node view replaces the editor DOM, so the identity `renderHTML` would have
  // emitted reaches it only through the factory's `attrs` option — and the
  // composer's own paste/serialize specs locate chips by `data-id`, while the
  // selection and pill-drag paths key off `data-type`.
  it("keeps the node's identity attributes on the chip in the editor DOM", async () => {
    const { container } = mountChip({ id: "stream_pi", slug: "pi-remote-control" })

    await screen.findByText("Pi remote control")
    const chips = container.querySelectorAll("[data-type='channelLink']")
    expect(chips).toHaveLength(1)
    expect(chips[0]?.getAttribute("data-id")).toBe("stream_pi")
    expect(chips[0]?.getAttribute("data-slug")).toBe("pi-remote-control")
    expect(chips[0]?.querySelector("[data-type='in-app-link-chip']")).not.toBeNull()
  })

  it("marks the same element on a node selection, so the selection styling matches it", async () => {
    let editor: Editor | undefined
    const { container } = mountChip({ id: "stream_pizza", slug: "pizza" }, (ready) => {
      editor = ready
    })

    await screen.findByText("#pizza")
    act(() => {
      editor!.commands.setNodeSelection(1)
    })

    // `index.css` styles a selected pill as `[data-type=…].ProseMirror-selectednode`,
    // so both have to be on one element.
    expect(container.querySelector("[data-type='channelLink']")).toHaveClass("ProseMirror-selectednode")
  })
})
