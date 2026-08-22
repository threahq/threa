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

const AGENT_BLOCK =
  "> — [Ariadne](agent:persona_01ARIADNE/stream_01ASIDE)\n>\n> Two options.\n>\n> - keep it\n> - drop it"

describe("MarkdownContent — agent block", () => {
  it("renders a received agent block as an attributed frame, not a blockquote", () => {
    renderMarkdown(AGENT_BLOCK)

    const block = document.querySelector('[data-type="agent-block"]')
    expect(block?.getAttribute("data-author-id")).toBe("persona_01ARIADNE")
    expect(screen.getByText("Ariadne")).toBeInTheDocument()
    expect(screen.getByText("Two options.")).toBeInTheDocument()
    expect(block?.querySelectorAll("li")).toHaveLength(2)
    // The attribution line itself is chrome, never body text.
    expect(screen.queryByText("agent:persona_01ARIADNE/stream_01ASIDE")).toBeNull()
  })

  it("leaves an ordinary blockquote alone", () => {
    renderMarkdown("> just a quote")
    expect(document.querySelector('[data-type="agent-block"]')).toBeNull()
    expect(screen.getByText("just a quote")).toBeInTheDocument()
  })

  it("does not credit a non-agent id as an agent", () => {
    renderMarkdown("> — [Alice](agent:usr_01HUMAN)\n>\n> not an agent")
    expect(document.querySelector('[data-type="agent-block"]')).toBeNull()
  })
})
