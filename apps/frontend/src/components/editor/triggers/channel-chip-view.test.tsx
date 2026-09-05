import { describe, it, expect, afterEach } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
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

function Harness({ attrs }: { attrs: { id: string; slug: string } }) {
  const editor = useEditor({
    extensions: [Document, Paragraph, Text, ChannelExtension],
    content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "channelLink", attrs }] }] },
  })
  return <EditorContent editor={editor} />
}

function mountChip(attrs: { id: string; slug: string }) {
  return render(
    <ChannelLinkProvider workspaceId="ws_1" streams={STREAMS}>
      <Harness attrs={attrs} />
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
    mountChip({ id: "stream_pizza", slug: "pizza" })

    expect(await screen.findByText("#pizza")).toBeInTheDocument()
  })

  it("relabels from the id, so a rename reaches a draft that already holds the chip", async () => {
    mountChip({ id: "stream_pi", slug: "old-name" })

    expect(await screen.findByText("Pi remote control")).toBeInTheDocument()
  })

  it("falls back to the authored slug for a target with no cached row", async () => {
    mountChip({ id: "stream_gone", slug: "ghost" })

    expect(await screen.findByText("#ghost")).toBeInTheDocument()
  })

  // A node view replaces the editor DOM, so the identity `renderHTML` would have
  // emitted is only there if the wrapper carries it — and the composer's own
  // paste/serialize specs locate chips by `data-id`.
  it("keeps the node's identity attributes on the chip in the editor DOM", async () => {
    const { container } = mountChip({ id: "stream_pi", slug: "pi-remote-control" })

    await screen.findByText("Pi remote control")
    const chip = container.querySelector("[data-type='channelLink']")
    expect(chip?.getAttribute("data-id")).toBe("stream_pi")
    expect(chip?.getAttribute("data-slug")).toBe("pi-remote-control")
  })
})
