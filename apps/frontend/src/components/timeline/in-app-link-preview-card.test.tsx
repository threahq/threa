import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { linkPreviewsApi } from "@/api"
import { InAppLinkPreviewCard, ComposerInAppLinkPreviewCard } from "./in-app-link-preview-card"
import type { InAppLinkPreviewData, LinkPreviewSummary } from "@threa/types"

const mockResolveInAppLink = vi.fn<typeof linkPreviewsApi.resolveInAppLink>()
const mockResolveInAppLinkByUrl = vi.fn<typeof linkPreviewsApi.resolveInAppLinkByUrl>()

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
    mockResolveInAppLinkByUrl.mockReset()
    vi.spyOn(linkPreviewsApi, "resolveInAppLink").mockImplementation((...args) => mockResolveInAppLink(...args))
    vi.spyOn(linkPreviewsApi, "resolveInAppLinkByUrl").mockImplementation((...args) =>
      mockResolveInAppLinkByUrl(...args)
    )
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

    await waitFor(() => expect(screen.getByText("Private conversation")).toBeInTheDocument())
    // Kind is named; no stream name, description, or visibility leaks.
    expect(screen.getByText("Conversation")).toBeInTheDocument()
    expect(screen.queryByText("design")).not.toBeInTheDocument()
  })

  it("shows a minimal card for a cross-workspace memo", async () => {
    renderWith(
      { kind: "memo", accessTier: "cross_workspace" },
      makePreview({ contentType: "memo_link", url: "https://app.threa.io/w/other_ws/memos/memo_1" })
    )

    await waitFor(() => expect(screen.getByText("In another workspace")).toBeInTheDocument())
    expect(screen.getByText("Memory")).toBeInTheDocument()
  })

  describe("ComposerInAppLinkPreviewCard", () => {
    const url = "https://app.threa.io/w/ws_123/s/stream_1"

    it("resolves the card straight from a URL via the by-url endpoint", async () => {
      mockResolveInAppLinkByUrl.mockResolvedValue({
        kind: "stream",
        accessTier: "full",
        streamName: "design",
        streamType: "channel",
        visibility: "public",
        description: "Where design happens",
      })

      render(
        <MemoryRouter>
          <ComposerInAppLinkPreviewCard url={url} workspaceId={workspaceId} />
        </MemoryRouter>
      )

      await waitFor(() => expect(screen.getByText("design")).toBeInTheDocument())
      expect(mockResolveInAppLinkByUrl).toHaveBeenCalledWith(workspaceId, url)
      expect(mockResolveInAppLink).not.toHaveBeenCalled()
    })

    it("dismisses with the link URL", async () => {
      const onDismiss = vi.fn()
      mockResolveInAppLinkByUrl.mockResolvedValue({ kind: "stream", accessTier: "private" })

      render(
        <MemoryRouter>
          <ComposerInAppLinkPreviewCard url={url} workspaceId={workspaceId} onDismiss={onDismiss} />
        </MemoryRouter>
      )

      const dismiss = await screen.findByLabelText("Dismiss preview")
      await userEvent.click(dismiss)
      expect(onDismiss).toHaveBeenCalledWith(url)
    })
  })
})
