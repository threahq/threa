import { beforeEach, describe, expect, it } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { MarkdownContent } from "@/components/ui/markdown-content"
import { PanelProvider, usePanel } from "@/contexts"
import { takeBlockFocus } from "@/lib/docs/block-focus"
import { spyOnExport } from "@/test"
import * as workspaceStore from "@/stores/workspace-store"

const STORED_DOCS: Record<string, { id: string; type: string; displayName: string | null }> = {
  stream_doc: { id: "stream_doc", type: "doc", displayName: "Launch plan" },
}

beforeEach(() => {
  spyOnExport(workspaceStore, "useWorkspaceStream").mockReturnValue(
    ((_workspaceId: string, streamId: string) => STORED_DOCS[streamId]) as never
  )
})

function renderAt(path: string, routePath: string, content: string, wrap: (node: ReactNode) => ReactNode = (n) => n) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={routePath} element={wrap(<MarkdownContent content={content} />)} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

function PanelUrlProbe({ onUrl }: { onUrl: (url: string) => void }) {
  onUrl(usePanel().getPanelUrl("stream_doc"))
  return null
}

function chipLink() {
  return document.querySelector('[data-type="doc-chip"]')?.closest("a") ?? null
}

describe("MarkdownContent — inline doc chip", () => {
  it("should render the doc's live title when the store holds the doc", () => {
    renderAt("/w/ws_1/s/stream_dst", "/w/:workspaceId/s/:streamId", "see [Old name](doc:stream_doc) today")

    expect(screen.getByText("Launch plan")).toBeInTheDocument()
    expect(screen.queryByText("Old name")).toBeNull()
  })

  it("should fall back to the link text when the doc is not in the store", () => {
    renderAt("/w/ws_1/s/stream_dst", "/w/:workspaceId/s/:streamId", "[Roadmap](doc:stream_unknown)")

    expect(document.querySelector('[data-type="doc-chip"]')?.textContent).toBe("Roadmap")
  })

  it("should link to the doc page when rendered outside a panel provider", () => {
    renderAt("/w/ws_1/s/stream_dst", "/w/:workspaceId/s/:streamId", "[Roadmap](doc:stream_doc)")

    expect(chipLink()?.getAttribute("href")).toBe("/w/ws_1/s/stream_doc")
  })

  it("should link to the doc's pane when rendered inside a panel provider", () => {
    let expected = ""
    renderAt("/w/ws_1/s/stream_dst", "/w/:workspaceId/s/:streamId", "[Roadmap](doc:stream_doc)", (node) => (
      <PanelProvider>
        <PanelUrlProbe onUrl={(url) => (expected = url)} />
        {node}
      </PanelProvider>
    ))

    expect(chipLink()?.getAttribute("href")).toBe(expected)
    expect(expected).toContain("panel=")
  })

  it("should request the pointed-at block when a chip with a block id is clicked", () => {
    renderAt("/w/ws_1/s/stream_dst", "/w/:workspaceId/s/:streamId", "[Roadmap](doc:stream_doc#blk_goals)")

    fireEvent.click(chipLink()!)

    expect(takeBlockFocus("stream_doc")).toBe("blk_goals")
  })

  it("should render the chip without a link when outside a workspace route", () => {
    renderAt("/", "/", "[Roadmap](doc:stream_doc)")

    expect(document.querySelector('[data-type="doc-chip"]')).not.toBeNull()
    expect(chipLink()).toBeNull()
  })
})
