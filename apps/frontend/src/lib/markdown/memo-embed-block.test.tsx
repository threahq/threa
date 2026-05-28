import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MarkdownContent } from "@/components/ui/markdown-content"

function renderMarkdown(content: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/w/ws_1/s/stream_dst"]}>
        <Routes>
          <Route path="/w/:workspaceId/s/:streamId" element={<MarkdownContent content={content} />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe("MarkdownContent — memoEmbed paragraph swap", () => {
  it("replaces a lone memo: anchor paragraph with the embed card", () => {
    renderMarkdown("[Auth rewrite plan](memo:memo_abc123)")

    const card = document.querySelector('[data-type="memo-embed"]')
    expect(card).not.toBeNull()
    // The card links into the memory explorer for that memo.
    const link = card?.closest("a")
    expect(link?.getAttribute("href")).toBe("/w/ws_1/memory?memo=memo_abc123")
    // Pre-hydration the card shows the title parsed from the link text.
    expect(screen.getByText("Auth rewrite plan")).toBeInTheDocument()
  })

  it("keeps a memo: link mixed into a sentence as an inline link, not a card", () => {
    renderMarkdown("see [Auth rewrite plan](memo:memo_abc123) for details")

    expect(document.querySelector('[data-type="memo-embed"]')).toBeNull()
    const inline = screen.getByText("Auth rewrite plan").closest("a")
    expect(inline?.getAttribute("href")).toBe("/w/ws_1/memory?memo=memo_abc123")
    expect(screen.getByText(/for details/)).toBeInTheDocument()
  })
})
