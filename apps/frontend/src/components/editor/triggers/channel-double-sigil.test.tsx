import { describe, it, expect, afterEach, beforeEach } from "vitest"
import { act, render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { Editor } from "@tiptap/core"
import Document from "@tiptap/extension-document"
import Paragraph from "@tiptap/extension-paragraph"
import Text from "@tiptap/extension-text"
import type { ReactNode } from "react"
import { spyOnExport } from "@/test"
import * as workspaceStoreModule from "@/stores/workspace-store"
import { useChannelSuggestion } from "./use-channel-suggestion"
import { ChannelExtension } from "./channel-extension"

const STREAMS = [
  { id: "stream_pizza", type: "channel", slug: "pizza", displayName: null, archivedAt: null },
  { id: "stream_pi", type: "scratchpad", slug: null, displayName: "Pi remote control", archivedAt: null },
  { id: "stream_blank", type: "scratchpad", slug: null, displayName: null, archivedAt: null },
]

let editor: Editor | null = null
let active = false

function Harness() {
  const { suggestionConfig, renderChannelList, isActive } = useChannelSuggestion()
  active = isActive
  if (!editor) {
    const element = document.createElement("div")
    document.body.appendChild(element)
    editor = new Editor({
      element,
      extensions: [Document, Paragraph, Text, ChannelExtension.configure({ suggestion: suggestionConfig })],
      content: "<p></p>",
    })
  }
  return <>{renderChannelList()}</>
}

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter initialEntries={["/w/ws_1"]}>
      <Routes>
        <Route path="/w/:workspaceId" element={children} />
      </Routes>
    </MemoryRouter>
  )
}

beforeEach(() => {
  spyOnExport(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue((() => STREAMS) as never)
})

afterEach(() => {
  if (editor && !editor.isDestroyed) editor.destroy()
  editor = null
  active = false
})

const settle = () =>
  act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

async function type(text: string) {
  render(
    <Wrapper>
      <Harness />
    </Wrapper>
  )
  await act(async () => {
    editor!.commands.insertContent(text)
  })
  await settle()
}

/** One transaction per character, the way a real keyboard produces the query. */
async function typeByKey(text: string) {
  render(
    <Wrapper>
      <Harness />
    </Wrapper>
  )
  for (const char of text) {
    await act(async () => {
      editor!.commands.insertContent(char)
    })
    await settle()
  }
}

const pickHighlighted = () =>
  editor!.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))

/** Every text and chip in the doc, in order. */
function docText() {
  return editor!.getText()
}

describe("# stream trigger", () => {
  it("offers channels and scratchpads for a single sigil", async () => {
    await type("#pi")

    expect(active).toBe(true)
    expect(screen.getByText("Pi remote control")).toBeInTheDocument()
    expect(screen.getByText("pizza")).toBeInTheDocument()
  })

  it("keeps the popup alive through a doubled sigil and narrows it to channels", async () => {
    await type("##pi")

    expect(active).toBe(true)
    expect(screen.getByText("pizza")).toBeInTheDocument()
    expect(screen.queryByText("Pi remote control")).not.toBeInTheDocument()
  })

  it("replaces both sigils when a channel is picked from the doubled form", async () => {
    await type("##pi")
    await act(async () => {
      pickHighlighted()
    })
    await settle()

    expect(docText().trim()).toBe("#pizza")
  })

  it("still links a channel from the bare sigil — the second one only narrows", async () => {
    await type("#pizz")
    await act(async () => {
      pickHighlighted()
    })
    await settle()

    const chip = editor!.getJSON().content?.[0].content?.[0]
    expect(chip).toMatchObject({ type: "channelLink", attrs: { id: "stream_pizza", slug: "pizza" } })
  })

  it("narrows to channels when the sigils and term arrive one keystroke at a time", async () => {
    await typeByKey("##pi")

    expect(active).toBe(true)
    expect(screen.getByText("pizza")).toBeInTheDocument()
    expect(screen.queryByText("Pi remote control")).not.toBeInTheDocument()
  })

  it("offers nothing for a bare `##`, so an h2 marker survives Enter", async () => {
    await type("##")
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument()

    await act(async () => {
      pickHighlighted()
    })
    await settle()

    // Enter fell through to the editor instead of picking a channel: the text
    // survives and the paragraph split (the composer binds send to that key).
    expect(docText().trim()).toBe("##")
    expect(editor!.getJSON().content?.[0].content?.[0]).toMatchObject({ type: "text", text: "##" })
  })

  it("leaves a stream with no name out of the list", async () => {
    await type("#")

    expect(screen.getByText("pizza")).toBeInTheDocument()
    expect(screen.queryByText("Untitled")).not.toBeInTheDocument()
  })

  it("inserts a scratchpad chip carrying the stream id, not a slug", async () => {
    await type("#remote")
    await act(async () => {
      pickHighlighted()
    })
    await settle()

    const chip = editor!.getJSON().content?.[0].content?.[0]
    expect(chip).toMatchObject({ type: "channelLink", attrs: { id: "stream_pi", slug: "pi-remote-control" } })
  })
})
