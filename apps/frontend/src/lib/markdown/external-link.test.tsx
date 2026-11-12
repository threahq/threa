import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import type { LinkPreviewSummary } from "@threahq/types"
import { MarkdownContent } from "@/components/ui/markdown-content"
import { LinkPreviewProvider } from "./link-preview-context"
import { linkFaviconUrl } from "@/api/link-previews"
import { db } from "@/db"
import * as workspaceStore from "@/stores/workspace-store"
import * as currentUserModule from "@/hooks/use-current-workspace-user-id"

function preview(url: string, faviconUrl: string | null): LinkPreviewSummary {
  return { url, faviconUrl } as LinkPreviewSummary
}

function renderMarkdown(content: string, previews: LinkPreviewSummary[] | null = []) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const markdown = <MarkdownContent content={content} />
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/w/ws_1/s/stream_here"]}>
        <Routes>
          <Route
            path="/w/:workspaceId/s/:streamId"
            element={previews ? <LinkPreviewProvider previews={previews}>{markdown}</LinkPreviewProvider> : markdown}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

function describeLink(anchor: HTMLAnchorElement) {
  const slot = anchor.querySelector('[aria-hidden="true"]')
  const markClass = slot?.querySelector(".external-link-mark")?.getAttribute("class")
  return {
    href: anchor.getAttribute("href"),
    target: anchor.getAttribute("target"),
    text: anchor.textContent,
    icon: markClass?.match(/external-link-icon-(github|linear|globe)/)?.[1] ?? null,
    img: slot?.querySelector("img")?.getAttribute("src") ?? null,
  }
}

function links() {
  return Array.from(document.querySelectorAll("a")).map(describeLink)
}

describe("MarkdownContent external links", () => {
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

  it("should render the compact label and provider mark when a bare GitHub PR url is posted", () => {
    renderMarkdown("https://github.com/threahq/threa/pull/2977", [
      preview("https://github.com/threahq/threa/pull/2977", "https://github.com/favicon.ico"),
    ])

    expect(links()).toEqual([
      {
        href: "https://github.com/threahq/threa/pull/2977",
        target: "_blank",
        text: "threahq/threa#2977",
        icon: "github",
        img: null,
      },
    ])
  })

  it("should keep the label and use the cached favicon when the host has a preview favicon", () => {
    renderMarkdown("Read [the docs](https://docs.example.com/a) and [other](https://other.example.com/b).", [
      preview("https://docs.example.com/a", "https://docs.example.com/favicon.ico"),
      preview("https://other.example.com/b", null),
    ])

    expect(links()).toEqual([
      {
        href: "https://docs.example.com/a",
        target: "_blank",
        text: "the docs",
        icon: null,
        img: linkFaviconUrl("ws_1", "docs.example.com"),
      },
      { href: "https://other.example.com/b", target: "_blank", text: "other", icon: "globe", img: null },
    ])
  })

  it("should fall back to the globe when the cached favicon fails to load", () => {
    renderMarkdown("[the docs](https://docs.example.com/a)", [
      preview("https://docs.example.com/a", "https://docs.example.com/favicon.ico"),
    ])

    fireEvent.error(document.querySelector("a img")!)

    expect(links()).toEqual([
      { href: "https://docs.example.com/a", target: "_blank", text: "the docs", icon: "globe", img: null },
    ])
  })

  it("should leave the link as it was when the markdown is not a message's", () => {
    renderMarkdown("https://github.com/threahq/threa/pull/2977", null)

    const anchor = document.querySelector("a")!
    expect({ ...describeLink(anchor), underlined: anchor.classList.contains("underline") }).toEqual({
      href: "https://github.com/threahq/threa/pull/2977",
      target: "_blank",
      text: "https://github.com/threahq/threa/pull/2977",
      icon: null,
      img: null,
      underlined: true,
    })
  })

  it("should render the Linear mark when a Linear link is labelled", () => {
    renderMarkdown("[ticket](https://linear.app/threa/issue/THR-51/link-decoration)")

    expect(links()).toEqual([
      {
        href: "https://linear.app/threa/issue/THR-51/link-decoration",
        target: "_blank",
        text: "ticket",
        icon: "linear",
        img: null,
      },
    ])
  })
})
