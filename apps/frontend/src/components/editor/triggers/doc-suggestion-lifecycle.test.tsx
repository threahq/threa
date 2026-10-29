import { afterEach, expect, it } from "vitest"
import { act, cleanup, render, screen, within } from "@testing-library/react"
import { EditorContent, useEditor } from "@tiptap/react"
import type { Editor } from "@tiptap/core"
import Document from "@tiptap/extension-document"
import Paragraph from "@tiptap/extension-paragraph"
import Text from "@tiptap/extension-text"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { seedWorkspaceCache, type CachedStream } from "@/stores/workspace-store"
import { DocEmbedExtension } from "../doc-embed-extension"
import { DocSearchExtension } from "./doc-search-extension"
import { useDocSuggestion } from "./use-doc-suggestion"

const workspaceId = "ws_doc_suggestion_lifecycle"
let editor: Editor | null = null
let suggestionConfig: ReturnType<typeof useDocSuggestion>["suggestionConfig"] | null = null

function Harness() {
  const suggestion = useDocSuggestion("stream_host")
  suggestionConfig = suggestion.suggestionConfig
  const { renderDocList } = suggestion
  editor = useEditor(
    {
      extensions: [
        Document,
        Paragraph,
        Text,
        DocEmbedExtension,
        DocSearchExtension.configure({ suggestion: suggestion.suggestionConfig }),
      ],
      content: "<p></p>",
    },
    []
  )
  return (
    <>
      <EditorContent editor={editor} />
      {renderDocList()}
    </>
  )
}

function RoutedHarness() {
  return (
    <MemoryRouter initialEntries={[`/w/${workspaceId}/s/stream_host`]}>
      <Routes>
        <Route path="/w/:workspaceId/s/:streamId" element={<Harness />} />
      </Routes>
    </MemoryRouter>
  )
}

function publishDocs(streams: CachedStream[]) {
  seedWorkspaceCache(workspaceId, {
    workspace: { id: workspaceId } as Parameters<typeof seedWorkspaceCache>[1]["workspace"],
    users: [],
    streams,
    memberships: [],
    dmPeers: [],
    personas: [],
    bots: [],
  })
}

afterEach(() => {
  cleanup()
  editor = null
  suggestionConfig = null
  publishDocs([])
})

it("should show a matching doc arriving while its suggestion query remains unchanged", async () => {
  publishDocs([])
  render(<RoutedHarness />)
  await act(async () => {
    editor!.commands.focus()
    editor!.commands.insertContent("/docs Runbook")
  })
  const picker = await screen.findByRole("listbox", { name: "Doc suggestions" })
  expect(within(picker).getByText("No docs found")).toBeVisible()
  const stateBeforePublication = editor!.state

  await act(async () => {
    publishDocs([
      {
        id: "stream_runbook",
        workspaceId,
        type: "doc",
        displayName: "Runbook launch",
        parentStreamId: "stream_host",
        archivedAt: null,
        createdAt: "2026-10-01T00:00:00.000Z",
      } as CachedStream,
    ])
  })

  expect(suggestionConfig!.items({ query: "Runbook" })).toEqual([
    expect.objectContaining({ id: "stream_runbook", displayName: "Runbook launch" }),
  ])
  expect(editor!.state).toBe(stateBeforePublication)
  expect(await within(picker).findByRole("option", { name: /Runbook launch/ })).toBeVisible()

  await act(async () => {
    editor!.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
  })

  expect(editor!.getJSON()).toEqual({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "docEmbed", attrs: { docId: "stream_runbook", blockId: null, title: "Runbook launch" } },
          { type: "text", text: " " },
        ],
      },
    ],
  })
  expect(screen.queryByRole("listbox", { name: "Doc suggestions" })).not.toBeInTheDocument()
})

it("should keep the selected doc when an unrelated parent render leaves its query unchanged", async () => {
  publishDocs([
    {
      id: "stream_first",
      workspaceId,
      type: "doc",
      displayName: "Runbook first",
      parentStreamId: "stream_host",
      archivedAt: null,
      createdAt: "2026-10-02T00:00:00.000Z",
    } as CachedStream,
    {
      id: "stream_second",
      workspaceId,
      type: "doc",
      displayName: "Runbook second",
      parentStreamId: "stream_host",
      archivedAt: null,
      createdAt: "2026-10-01T00:00:00.000Z",
    } as CachedStream,
  ])
  const view = render(<RoutedHarness />)
  await act(async () => {
    editor!.commands.focus()
    editor!.commands.insertContent("/docs Runbook")
  })
  const picker = await screen.findByRole("listbox", { name: "Doc suggestions" })
  await act(async () => {
    editor!.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }))
  })
  expect(within(picker).getByRole("option", { name: /Runbook second/ })).toHaveAttribute("aria-selected", "true")
  const stateBeforeRerender = editor!.state

  view.rerender(<RoutedHarness />)

  expect(editor!.state).toBe(stateBeforeRerender)
  await act(async () => {
    editor!.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
  })
  expect(editor!.getJSON()).toEqual({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "docEmbed", attrs: { docId: "stream_second", blockId: null, title: "Runbook second" } },
          { type: "text", text: " " },
        ],
      },
    ],
  })
})
