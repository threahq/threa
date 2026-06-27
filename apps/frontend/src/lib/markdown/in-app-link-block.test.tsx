import { describe, expect, it, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MarkdownContent } from "@/components/ui/markdown-content"
import * as workspaceStore from "@/stores/workspace-store"

const origin = window.location.origin

function seedStreams(streams: Array<Record<string, unknown>>) {
  vi.spyOn(workspaceStore, "useWorkspaceStreams").mockReturnValue(
    streams as unknown as ReturnType<typeof workspaceStore.useWorkspaceStreams>
  )
  vi.spyOn(workspaceStore, "useWorkspaceUsers").mockReturnValue([])
  vi.spyOn(workspaceStore, "useWorkspaceDmPeers").mockReturnValue([])
}

function renderMarkdown(content: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/w/ws_1/s/stream_here"]}>
        <Routes>
          <Route path="/w/:workspaceId/s/:streamId" element={<MarkdownContent content={content} />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe("MarkdownContent — inline in-app link chip", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("renders an in-app stream link as an inline chip with the locally-resolved name", () => {
    seedStreams([{ id: "stream_1", type: "channel", slug: "design", displayName: null }])
    const url = `${origin}/w/ws_1/s/stream_1`
    renderMarkdown(`see [whatever](${url}) here`)

    const chip = document.querySelector('[data-type="in-app-link-chip"]')
    expect(chip).not.toBeNull()
    // Local cache wins over the link text — the chip names the channel.
    expect(screen.getByText("#design")).toBeInTheDocument()
    expect(chip?.closest("a")?.getAttribute("href")).toBe(`${origin}/w/ws_1/s/stream_1`)
  })

  it("leaves a plain web link as an underlined anchor (no chip)", () => {
    seedStreams([])
    renderMarkdown("read [the blog](https://example.com/post)")

    expect(document.querySelector('[data-type="in-app-link-chip"]')).toBeNull()
    expect(screen.getByText("the blog").closest("a")?.getAttribute("href")).toBe("https://example.com/post")
  })
})
