import { describe, it, expect, vi, afterEach } from "vitest"
import { act, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { SuggestionProps } from "@tiptap/suggestion"
import type { Memo } from "@threa/types"
import { api } from "@/api/client"
import { useMemoSuggestion } from "./use-memo-suggestion"

type MemoSuggestionConfig = ReturnType<typeof useMemoSuggestion>["suggestionConfig"]

function Harness({ capture }: { capture: (cfg: MemoSuggestionConfig) => void }) {
  const { suggestionConfig, renderMemoList } = useMemoSuggestion()
  capture(suggestionConfig)
  return <>{renderMemoList()}</>
}

// Drive the picker for the given query with the given results. onStart only
// reads editor.storage, items, query, clientRect and command, so a partial
// props object is sufficient. `storage` is the editor.storage.memoSearch object
// the hook writes popupVisible into — pass one in to assert on it.
function activateWith(
  cfg: MemoSuggestionConfig,
  query: string,
  items: Memo[],
  storage: Record<string, unknown> = {}
) {
  const props = {
    editor: { storage: { memoSearch: storage } },
    items,
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

afterEach(() => {
  vi.restoreAllMocks()
})

function makeMemo(overrides: Partial<Memo>): Memo {
  return { id: "memo_1", title: "Recent memo", knowledgeType: "decision", tags: [], ...overrides } as unknown as Memo
}

describe("/memo picker discoverability", () => {
  it("fetches and shows the first page of memos when /memo opens with no query typed", async () => {
    const postSpy = vi
      .spyOn(api, "post")
      .mockResolvedValue({ results: [{ memo: makeMemo({ title: "Recent memo" }) }] } as never)
    const getCfg = renderPicker()

    const items = (await getCfg().items({ query: "" })) as Memo[]

    // An empty query searches (returns recent memos) rather than short-circuiting.
    expect(postSpy).toHaveBeenCalledWith("/api/workspaces/ws_1/memos/search", expect.objectContaining({ query: "" }))
    expect(items.map((m) => m.title)).toEqual(["Recent memo"])

    activateWith(getCfg(), "", items)
    await waitFor(() => expect(screen.getByText("Recent memo")).toBeInTheDocument())
  })

  it("says nothing matched when a query returns no memos", () => {
    const getCfg = renderPicker()
    activateWith(getCfg(), "auth rewrite", [])
    expect(screen.getByText("No memos found")).toBeInTheDocument()
  })

  it("marks the popup visible even with zero results so Escape dismisses it (not blur the editor)", () => {
    const getCfg = renderPicker()
    const storage: { popupVisible?: boolean } = {}
    // An empty result set still renders the empty-state popup; popupVisible must
    // be true so isSuggestionActive reports it and Escape/Enter route to the picker.
    activateWith(getCfg(), "", [], storage)
    expect(storage.popupVisible).toBe(true)
  })
})
