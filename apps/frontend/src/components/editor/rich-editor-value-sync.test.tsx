import { it, expect, vi, beforeEach, afterEach } from "vitest"
import { createRef, useState } from "react"
import { act, render, cleanup, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { JSONContent } from "@threahq/types"
import { spyOnExport } from "@/test/spy"
import * as mentionablesModule from "@/hooks/use-mentionables"
import * as emojiModule from "@/hooks/use-workspace-emoji"
import * as giphyModule from "@/hooks/use-giphy-enabled"
import * as streamCommandsModule from "@/hooks/use-stream-commands"
import * as createDocModule from "@/hooks/use-create-doc"
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
  spyOnExport(createDocModule, "useCreateDoc").mockReturnValue((() => ({
    enabled: false,
    run: async () => null,
  })) as never)
  spyOnExport(contextsModule, "usePreferences").mockReturnValue((() => NO_PREFERENCES) as never)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const EMPTY_DOC: JSONContent = { type: "doc", content: [{ type: "paragraph" }] }

function mountControlledEditor() {
  const ref = createRef<RichEditorHandle>()
  let emitted: JSONContent | null = null
  let replaceValue: (value: JSONContent) => void = () => {}

  function ControlledEditor() {
    const [value, setValue] = useState(EMPTY_DOC)
    replaceValue = setValue
    return (
      <RichEditor
        ref={ref}
        value={value}
        onChange={(next) => {
          emitted = next
          setValue(next)
        }}
        onSubmit={() => undefined}
        ariaLabel="Message input"
      />
    )
  }

  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/w/ws_1/s/stream_1"]}>
        <Routes>
          <Route path="/w/:workspaceId/s/:streamId" element={<ControlledEditor />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )

  return {
    editor: ref.current!.getEditor()!,
    replace: (value: JSONContent) => replaceValue(value),
    emitted: () => emitted!,
  }
}

it("should restore a previously emitted document when an external clear is undone", () => {
  const { editor, replace, emitted } = mountControlledEditor()
  act(() => {
    editor.commands.insertContent("restore this draft")
  })
  const saved = emitted()
  act(() => replace(EMPTY_DOC))
  expect(screen.getByRole("textbox", { name: "Message input" }).textContent).toBe("")

  act(() => replace(saved))

  expect(screen.getByRole("textbox", { name: "Message input" })).toHaveTextContent("restore this draft")
})
