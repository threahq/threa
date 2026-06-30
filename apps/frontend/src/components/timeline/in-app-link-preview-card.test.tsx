import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { linkPreviewsApi } from "@/api"
import * as workspaceStoreModule from "@/stores/workspace-store"
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
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <InAppLinkPreviewCard preview={preview} workspaceId={workspaceId} />
        </MemoryRouter>
      </QueryClientProvider>
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

  it("renders a DM message link with the peer name and no channel #", async () => {
    vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue([] as never)
    vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue([
      { id: "usr_peer", name: "Ada Lovelace" },
    ] as never)
    vi.spyOn(workspaceStoreModule, "useWorkspaceDmPeers").mockReturnValue([
      { streamId: "stream_dm", userId: "usr_peer" },
    ] as never)

    renderWith(
      { kind: "message", accessTier: "full", deleted: false, authorName: "Bob", contentPreview: "hi" },
      makePreview({ contentType: "message_link", url: `${window.location.origin}/w/ws_123/s/stream_dm?m=msg_1` })
    )

    await waitFor(() => expect(screen.getByText("Ada Lovelace")).toBeInTheDocument())
    expect(screen.queryByText("#Ada Lovelace")).not.toBeInTheDocument()
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

  it("prefers the locally-resolved DM name over the backend 'Conversation' fallback", async () => {
    // A DM has no streamName on the backend resolve; the card must fall back to
    // the per-viewer name from the dm-peers cache (same source the composer chip uses).
    vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue([] as never)
    vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue([
      { id: "usr_peer", name: "Ada Lovelace" },
    ] as never)
    vi.spyOn(workspaceStoreModule, "useWorkspaceDmPeers").mockReturnValue([
      { streamId: "stream_dm", userId: "usr_peer" },
    ] as never)

    renderWith(
      { kind: "stream", accessTier: "full", streamType: "dm", visibility: "private" },
      makePreview({ contentType: "stream_link", url: `${window.location.origin}/w/ws_123/s/stream_dm` })
    )

    // The body shows the resolved peer name; "Conversation" remains only as the
    // header's kind label, which is correct for a DM.
    await waitFor(() => expect(screen.getByText("Ada Lovelace")).toBeInTheDocument())
  })

  it("shows a minimal card for a cross-workspace memo", async () => {
    renderWith(
      { kind: "memo", accessTier: "cross_workspace" },
      makePreview({ contentType: "memo_link", url: "https://app.threa.io/w/other_ws/memos/memo_1" })
    )

    await waitFor(() => expect(screen.getByText("In another workspace")).toBeInTheDocument())
    expect(screen.getByText("Memory")).toBeInTheDocument()
  })

  it("renders synchronously from baked inAppData without an async resolve", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <InAppLinkPreviewCard
            preview={makePreview({
              contentType: "message_link",
              url: "not a valid url",
              inAppData: {
                kind: "message",
                accessTier: "full",
                deleted: false,
                streamName: "general",
                authorName: "Baked Author",
                contentPreview: "Baked snippet",
              },
            })}
            workspaceId={workspaceId}
          />
        </MemoryRouter>
      </QueryClientProvider>
    )

    // Content is present on first paint (no waitFor) and the resolve endpoint is never hit.
    expect(screen.getByText("Baked Author")).toBeInTheDocument()
    expect(screen.getByText("Baked snippet")).toBeInTheDocument()
    expect(mockResolveInAppLink).not.toHaveBeenCalled()
  })
})
