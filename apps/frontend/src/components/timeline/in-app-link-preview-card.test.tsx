import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { linkPreviewsApi } from "@/api"
import { InAppLinkPreviewCard } from "./in-app-link-preview-card"
import type { InAppLinkPreviewData, LinkPreviewSummary } from "@threa/types"

const mockResolveInAppLink = vi.fn<typeof linkPreviewsApi.resolveInAppLink>()

function makePreview(overrides: Partial<LinkPreviewSummary> = {}): LinkPreviewSummary {
  return {
    id: "preview_1",
    url: "https://app.threa.io/w/ws_123/s/stream_1",
    position: 0,
    title: null,
    description: null,
    siteName: null,
    faviconUrl: null,
    imageUrl: null,
    contentType: "stream_link",
    ...overrides,
  }
}

describe("InAppLinkPreviewCard", () => {
  const workspaceId = "ws_123"

  beforeEach(() => {
    vi.restoreAllMocks()
    mockResolveInAppLink.mockReset()
    vi.spyOn(linkPreviewsApi, "resolveInAppLink").mockImplementation((...args) => mockResolveInAppLink(...args))
  })

  function renderWith(data: InAppLinkPreviewData, preview: LinkPreviewSummary) {
    mockResolveInAppLink.mockResolvedValue(data)
    render(
      <MemoryRouter>
        <InAppLinkPreviewCard preview={preview} workspaceId={workspaceId} />
      </MemoryRouter>
    )
  }

  it("renders a full-access message link with author and stream", async () => {
    renderWith(
      {
        kind: "message",
        accessTier: "full",
        deleted: false,
        streamName: "general",
        authorName: "Test User",
        contentPreview: "Hello from preview",
      },
      makePreview({ contentType: "message_link", url: "not a valid url" })
    )

    await waitFor(() => {
      expect(screen.getByText("Test User")).toBeInTheDocument()
      expect(screen.getByText("#general")).toBeInTheDocument()
    })
    expect(screen.getByText("Hello from preview")).toBeInTheDocument()
  })

  it("renders a full-access stream link with name and description", async () => {
    renderWith(
      {
        kind: "stream",
        accessTier: "full",
        streamName: "design",
        streamType: "channel",
        visibility: "public",
        description: "Where design happens",
      },
      makePreview()
    )

    await waitFor(() => expect(screen.getByText("design")).toBeInTheDocument())
    expect(screen.getByText("Where design happens")).toBeInTheDocument()
    expect(screen.getByText("Public")).toBeInTheDocument()
  })

  it("renders a full-access memo link with title and abstract", async () => {
    renderWith(
      {
        kind: "memo",
        accessTier: "full",
        title: "How auth works",
        abstract: "Auth flows through the workspace router.",
        knowledgeType: "decision",
        sourceStreamName: "eng",
      },
      makePreview({ contentType: "memo_link", url: "https://app.threa.io/w/ws_123/memos/memo_1" })
    )

    await waitFor(() => expect(screen.getByText("How auth works")).toBeInTheDocument())
    expect(screen.getByText("Auth flows through the workspace router.")).toBeInTheDocument()
    expect(screen.getByText("From #eng")).toBeInTheDocument()
  })

  it("shows a minimal card for a private stream without leaking content", async () => {
    renderWith({ kind: "stream", accessTier: "private" }, makePreview())

    await waitFor(() => expect(screen.getByText("A private conversation")).toBeInTheDocument())
  })

  it("shows a minimal card for a cross-workspace memo", async () => {
    renderWith(
      { kind: "memo", accessTier: "cross_workspace" },
      makePreview({ contentType: "memo_link", url: "https://app.threa.io/w/other_ws/memos/memo_1" })
    )

    await waitFor(() => expect(screen.getByText("A memory in Threa")).toBeInTheDocument())
  })
})
