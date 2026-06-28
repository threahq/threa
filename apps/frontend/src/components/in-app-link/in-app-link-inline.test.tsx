import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { linkPreviewsApi } from "@/api"
import * as workspaceStore from "@/stores/workspace-store"
import { InAppLinkInline } from "./in-app-link-inline"

const origin = window.location.origin

function renderMessageLink(streamId: string) {
  const href = `${origin}/w/ws_1/s/${streamId}?m=msg_1`
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <InAppLinkInline href={href} workspaceId="ws_1" streamId={streamId} messageId="msg_1" fallbackLabel="" />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe("InAppLinkInline (message chip)", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("renders a DM message as '{author} to {recipient}' with full names", async () => {
    vi.spyOn(linkPreviewsApi, "resolveInAppLinkByUrl").mockResolvedValue({
      kind: "message",
      accessTier: "full",
      authorName: "Pierre Boberg",
      streamType: "dm",
      recipientName: "Kristoffer Remback",
    })

    renderMessageLink("stream_dm")

    // Author leads (truncatable); the recipient is the pinned suffix.
    const lead = await screen.findByText("Pierre Boberg")
    expect(screen.getByText("to Kristoffer Remback")).toBeInTheDocument()
    expect(lead.closest("a")).toHaveAttribute("href", `${origin}/w/ws_1/s/stream_dm?m=msg_1`)
    // Author face leads the chip; with no avatar URL it shows the initial fallback.
    expect(screen.getByText("P")).toBeInTheDocument()
  })

  it("renders a channel message as '{author} in #slug'", async () => {
    vi.spyOn(linkPreviewsApi, "resolveInAppLinkByUrl").mockResolvedValue({
      kind: "message",
      accessTier: "full",
      authorName: "Kristoffer Remback",
      streamType: "channel",
      streamName: "tech-big-new-prop",
    })

    renderMessageLink("stream_1")

    await waitFor(() => expect(screen.getByText("Kristoffer Remback")).toBeInTheDocument())
    expect(screen.getByText("in #tech-big-new-prop")).toBeInTheDocument()
  })

  it("settles a fully-resolved but unnamed (bot/persona) message to 'Message', not the parent stream name", async () => {
    // Cached parent stream would resolve to "#general"; the rich label is null
    // (no author), so the chip must settle on "Message" rather than the stream name.
    vi.spyOn(workspaceStore, "useWorkspaceStreams").mockReturnValue([
      { id: "stream_1", type: "channel", slug: "general", displayName: null },
    ] as never)
    vi.spyOn(linkPreviewsApi, "resolveInAppLinkByUrl").mockResolvedValue({
      kind: "message",
      accessTier: "full",
      streamType: "channel",
      streamName: "general",
    })

    renderMessageLink("stream_1")

    await waitFor(() => expect(screen.getByText("Message")).toBeInTheDocument())
    expect(screen.queryByText("#general")).not.toBeInTheDocument()
  })

  it("shows a deleted-message placeholder instead of a live chip", async () => {
    vi.spyOn(linkPreviewsApi, "resolveInAppLinkByUrl").mockResolvedValue({
      kind: "message",
      accessTier: "full",
      deleted: true,
    })

    renderMessageLink("stream_1")

    await waitFor(() => expect(screen.getByText("Deleted message")).toBeInTheDocument())
  })
})
