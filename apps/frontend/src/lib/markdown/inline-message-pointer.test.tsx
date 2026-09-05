import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { MarkdownContent } from "@/components/ui/markdown-content"
import { linkPreviewsApi } from "@/api"
import { db } from "@/db"
import * as workspaceStore from "@/stores/workspace-store"
import * as currentUserModule from "@/hooks/use-current-workspace-user-id"

function renderMarkdown(content: string, route = "/w/ws_1/s/stream_here") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route path="/w/:workspaceId/s/:streamId" element={<MarkdownContent content={content} />} />
          <Route path="/outside" element={<MarkdownContent content={content} />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe("MarkdownContent inline message pointers", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(currentUserModule, "useCurrentWorkspaceUserId").mockReturnValue("user_viewer")
    vi.spyOn(workspaceStore, "useWorkspaceStreams").mockReturnValue([])
    vi.spyOn(workspaceStore, "useWorkspaceUsers").mockReturnValue([])
    vi.spyOn(workspaceStore, "useWorkspaceDmPeers").mockReturnValue([])
  })

  afterEach(async () => {
    await db.events.clear()
  })

  it("should navigate an inline shared-message pointer while preserving its author label", () => {
    renderMarkdown("See [Ariadne](shared-message:stream_src/msg_abc) for context.")

    expect(screen.getByRole("link", { name: "Ariadne" })).toHaveAttribute("href", "/w/ws_1/s/stream_src?m=msg_abc")
    expect(document.querySelector('[data-type="shared-message"]')).toBeNull()
  })

  it("should navigate an inline shared-message pointer to its conversation destination", () => {
    renderMarkdown("See [Ariadne](shared-message:stream_src/msg_abc/conv_xyz?v=2&r=1-4).")

    const href = screen.getByRole("link", { name: "Ariadne" }).getAttribute("href") ?? ""
    expect(href).toContain("/w/ws_1/board?")
    expect(href).toContain("panel=conv%3Aconv_xyz")
    expect(href).toContain("m=msg_abc")
  })

  it("should navigate an inline quote pointer while preserving its label", () => {
    renderMarkdown("Revisit [the original answer](quote:stream_src/msg_abc/usr_1/user?v=3&r=2-8).")

    expect(screen.getByRole("link", { name: "the original answer" })).toHaveAttribute(
      "href",
      "/w/ws_1/s/stream_src?m=msg_abc"
    )
  })

  it("should show a generic pending label for a repaired bare message ID", () => {
    vi.spyOn(linkPreviewsApi, "resolveInAppLinkByUrl").mockReturnValue(new Promise(() => {}))
    const messageId = "msg_01ARZ3NDEKTSV4RRFFQ69G5FAV"
    renderMarkdown(`[${messageId}](shared-message:stream_src/${messageId}) is relevant.`)

    expect(screen.getByRole("link", { name: "Message" })).toHaveAttribute("href", `/w/ws_1/s/stream_src?m=${messageId}`)
    expect(screen.queryByText(messageId)).not.toBeInTheDocument()
  })

  it("should not navigate a pointer whose segments are not id-shaped", () => {
    renderMarkdown("See [thing](shared-message:foo/bar) here.")

    // Falls through to the ordinary external-link branch: renders as text/anchor
    // but never as a navigable in-app chip built from junk segments.
    expect(document.querySelector('[data-type="shared-message"]')).toBeNull()
  })

  it("should leave an inline pointer inert without a workspace route", () => {
    renderMarkdown("See [Ariadne](shared-message:stream_src/msg_abc).", "/outside")

    expect(screen.getByText("Ariadne")).toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "Ariadne" })).not.toBeInTheDocument()
  })

  it("should leave pointer text inside inline and fenced code unchanged", () => {
    const pointer = "[Ariadne](shared-message:stream_src/msg_abc)"
    renderMarkdown(`\`${pointer}\`\n\n\`\`\`text\n${pointer}\n\`\`\``)

    expect(screen.getAllByText(pointer)).toHaveLength(2)
    expect(screen.queryByRole("link", { name: "Ariadne" })).not.toBeInTheDocument()
  })
})
