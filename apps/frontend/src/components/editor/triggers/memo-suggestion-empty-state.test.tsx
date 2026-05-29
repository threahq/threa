import { describe, it, expect } from "vitest"
import { act, render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { SuggestionProps } from "@tiptap/suggestion"
import type { Memo } from "@threa/types"
import { useMemoSuggestion } from "./use-memo-suggestion"

type MemoSuggestionConfig = ReturnType<typeof useMemoSuggestion>["suggestionConfig"]

function Harness({ capture }: { capture: (cfg: MemoSuggestionConfig) => void }) {
  const { suggestionConfig, renderMemoList } = useMemoSuggestion()
  capture(suggestionConfig)
  return <>{renderMemoList()}</>
}

// Drive the picker into an empty-results state for the given query. onStart only
// reads editor.storage, items, query, clientRect and command, so a partial props
// object is sufficient.
function activateWithEmptyResults(cfg: MemoSuggestionConfig, query: string) {
  const props = {
    editor: { storage: { memoSearch: {} } },
    items: [] as Memo[],
    query,
    clientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }),
    command: () => {},
  } as unknown as SuggestionProps<Memo>
  act(() => {
    cfg.render().onStart(props)
  })
}

function renderPicker() {
  let cfg: MemoSuggestionConfig | null = null
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/w/ws_1/s/stream_1"]}>
        <Routes>
          <Route
            path="/w/:workspaceId/s/:streamId"
            element={
              <Harness
                capture={(c) => {
                  cfg = c
                }}
              />
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
  return () => cfg!
}

describe("/memo picker empty state", () => {
  it("prompts to keep typing before the query is long enough to search", () => {
    const getCfg = renderPicker()
    activateWithEmptyResults(getCfg(), "")
    expect(screen.getByText("Type to search memos")).toBeInTheDocument()
  })

  it("says nothing matched once the query is searchable but returns no memos", () => {
    const getCfg = renderPicker()
    activateWithEmptyResults(getCfg(), "auth rewrite")
    expect(screen.getByText("No memos found")).toBeInTheDocument()
  })
})
