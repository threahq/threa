import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoPreviewList } from "./memo-preview-list"

function renderPreviews(contentMarkdown: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/w/ws_1/s/stream_dst"]}>
        <Routes>
          <Route path="/w/:workspaceId/s/:streamId" element={<MemoPreviewList contentMarkdown={contentMarkdown} />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe("MemoPreviewList", () => {
  it("renders nothing when the body has no memo references", () => {
    const { container } = renderPreviews("plain text with a [link](https://example.com)")
    expect(container).toBeEmptyDOMElement()
  })

  it("renders one preview card per referenced memo, linking to the memory explorer", () => {
    renderPreviews("See [Auth rewrite](memo:memo_01ABC) and [Roadmap](memo:memo_02DEF)")

    const cards = document.querySelectorAll('[data-type="memo-embed"]')
    expect(cards).toHaveLength(2)
    const hrefs = Array.from(cards, (card) => card.closest("a")?.getAttribute("href"))
    expect(hrefs).toEqual(["/w/ws_1/memory?memo=memo_01ABC", "/w/ws_1/memory?memo=memo_02DEF"])
    // Pre-hydration the card shows the title parsed from the reference.
    expect(screen.getByText("Auth rewrite")).toBeInTheDocument()
    expect(screen.getByText("Roadmap")).toBeInTheDocument()
  })

  it("de-duplicates repeated references to the same memo", () => {
    renderPreviews("[Auth rewrite](memo:memo_01ABC) ... again [Auth rewrite](memo:memo_01ABC)")
    expect(document.querySelectorAll('[data-type="memo-embed"]')).toHaveLength(1)
  })
})
