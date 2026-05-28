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

describe("MarkdownContent — inline memo chip", () => {
  it("renders a lone memo: reference as an inline chip linking to the memo", () => {
    renderMarkdown("[Auth rewrite plan](memo:memo_abc123)")

    const chip = document.querySelector('[data-type="memo-chip"]')
    expect(chip).not.toBeNull()
    const link = chip?.closest("a")
    expect(link?.getAttribute("href")).toBe("/w/ws_1/memory?memo=memo_abc123")
    expect(screen.getByText("Auth rewrite plan")).toBeInTheDocument()
    // The body renders the chip only; the hydrated preview card is a separate
    // surface (MemoPreviewList), not part of the markdown body.
    expect(document.querySelector('[data-type="memo-embed"]')).toBeNull()
  })

  it("renders a memo: reference mid-sentence as an inline chip with surrounding text", () => {
    renderMarkdown("see [Auth rewrite plan](memo:memo_abc123) for details")

    const chip = document.querySelector('[data-type="memo-chip"]')
    expect(chip).not.toBeNull()
    expect(chip?.closest("a")?.getAttribute("href")).toBe("/w/ws_1/memory?memo=memo_abc123")
    expect(screen.getByText(/see/)).toBeInTheDocument()
    expect(screen.getByText(/for details/)).toBeInTheDocument()
  })
})
