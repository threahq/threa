import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
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

  it("renders one preview card per referenced memo as a button that opens a preview (not a link)", () => {
    renderPreviews("See [Auth rewrite](memo:memo_01ABC) and [Roadmap](memo:memo_02DEF)")

    const cards = document.querySelectorAll('[data-type="memo-embed"]')
    expect(cards).toHaveLength(2)
    // Clicking a card opens an in-stream preview dialog, so the card is a
    // button rather than a navigating link.
    cards.forEach((card) => {
      expect(card.closest("button")).not.toBeNull()
      expect(card.closest("a")).toBeNull()
    })
    // Pre-hydration the card shows the title parsed from the reference.
    expect(screen.getByText("Auth rewrite")).toBeInTheDocument()
    expect(screen.getByText("Roadmap")).toBeInTheDocument()
  })

  it("opens a preview dialog linking to the memory explorer when a card is clicked", async () => {
    renderPreviews("[Auth rewrite](memo:memo_01ABC)")

    const card = document.querySelector('[data-type="memo-embed"]')
    await userEvent.click(card!.closest("button")!)

    // The dialog footer links through to the full memo in the memory explorer.
    const link = await screen.findByRole("link", { name: /open in memory/i })
    expect(link.getAttribute("href")).toBe("/w/ws_1/memory?memo=memo_01ABC")
  })

  it("de-duplicates repeated references to the same memo", () => {
    renderPreviews("[Auth rewrite](memo:memo_01ABC) ... again [Auth rewrite](memo:memo_01ABC)")
    expect(document.querySelectorAll('[data-type="memo-embed"]')).toHaveLength(1)
  })
})
