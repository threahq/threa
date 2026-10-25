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

describe("MarkdownContent — private quote", () => {
  it("should show a private quote as a placeholder with no link to its source when the author couldn't read it", () => {
    renderMarkdown("> — [Private quote](quote:stream_src/msg_src?private=1)\n\nafter")

    expect({
      label: screen.getByText("Private quote").tagName,
      links: screen.queryAllByRole("link").length,
      body: screen.getByText("after").tagName,
    }).toEqual({ label: "SPAN", links: 0, body: "P" })
  })
})
